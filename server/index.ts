import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { buildTools, listMcpTools, type ToolSpec } from "./tools.js";
import { deleteRun, getRun, listRuns, recordStep } from "./trace.js";

dotenv.config();

const PORT = Number(process.env.PORT ?? 8787);
const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const MISSING_KEY = "OPENAI_API_KEY is not set. Copy .env.example to .env, add your key, and restart.";

if (!process.env.OPENAI_API_KEY) console.warn(`[mnemonic] ${MISSING_KEY}`);

// Constructed lazily: the SDK throws on a missing key, and the UI is still worth serving
// so the graph can be built and inspected before a key is in place.
let cached: OpenAI | null = null;
function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error(MISSING_KEY), { status: 401 });
  return (cached ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
}

/** Models we fall back to when the /models listing is unavailable. */
const FALLBACK_MODELS = ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4o", "gpt-4o-mini"];

/**
 * The API has no notion of a deprecated model — /v1/models returns everything the account can
 * reach. So: drop other modalities and purpose-built variants, collapse dated snapshots into
 * their alias, and order by release date so current models come first.
 */
const OTHER_MODALITIES =
  /(embedding|audio|realtime|transcribe|tts|image|moderation|dall-e|whisper|sora|live-)/;
const SPECIAL_PURPOSE = /(codex|deep-research|search-api|search-preview|instruct|-16k)/;
const DATED = /-(\d{4}-\d{2}-\d{2}|\d{4})$/;

function usableModels(models: { id: string; created?: number }[]): string[] {
  const candidates = models.filter(
    ({ id }) =>
      /^(gpt-|o[1345](-|$)|chat)/.test(id) && !OTHER_MODALITIES.test(id) && !SPECIAL_PURPOSE.test(id),
  );

  // A dated snapshot is redundant when its alias is also offered; keep the alias.
  const aliases = new Set(candidates.map((m) => m.id));
  return candidates
    .filter(({ id }) => {
      const base = id.replace(DATED, "");
      return base === id || !aliases.has(base);
    })
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => m.id);
}

app.get("/api/models", async (_req, res) => {
  try {
    const list = await getClient().models.list();
    const ids = usableModels(list.data);
    res.json({ models: ids.length ? ids : FALLBACK_MODELS });
  } catch (err) {
    console.warn("[mnemonic] model listing failed, serving fallback list:", (err as Error).message);
    res.json({ models: FALLBACK_MODELS, fallback: true });
  }
});

app.post("/api/mcp/tools", async (req, res) => {
  const { serverUrl, authorization } = req.body ?? {};
  if (typeof serverUrl !== "string" || !serverUrl.trim()) {
    return res.status(400).json({ error: "serverUrl is required" });
  }
  try {
    const { tools, resolvedUrl } = await listMcpTools(serverUrl, authorization || undefined);
    res.json({ tools, resolvedUrl });
  } catch (err) {
    res.status(502).json({ error: `could not reach MCP server: ${(err as Error).message}` });
  }
});

/** A tool-calling run can bounce a few times before the model settles on an answer. */
const MAX_TOOL_ROUNDS = 6;

app.post("/api/run", async (req, res) => {
  const { model, effort, input, instructions, tools: toolSpecs, trace } = req.body ?? {};
  if (typeof model !== "string" || typeof input !== "string" || !input.trim()) {
    return res.status(400).json({ error: "model and a non-empty input are required" });
  }

  const startedMs = Date.now();
  /** Every request/response pair in the tool loop, kept verbatim for the trace. */
  const rounds: unknown[] = [];

  const save = async (status: "ok" | "error", extra: Record<string, unknown>) => {
    if (!trace?.runId) return;
    try {
      await recordStep({
        execId: trace.execId ?? `${trace.runId}-${trace.seq ?? 0}`,
        runId: trace.runId,
        kind: trace.kind ?? "run",
        seq: trace.seq ?? 0,
        nodeId: trace.nodeId ?? "",
        label: trace.label ?? "",
        requestedModel: model,
        effort: effort ?? "off",
        startedMs,
        finishedMs: Date.now(),
        status,
        systemPrompt: typeof instructions === "string" ? instructions : null,
        inputPrompt: input,
        context: trace.context ?? null,
        tools: toolSpecs ?? [],
        rounds,
        servedModel: null,
        error: null,
        toolCalls: null,
        outputText: null,
        usage: null,
        ...extra,
      });
    } catch (err) {
      // A trace failure must never take a run down with it.
      console.error("[mnemonic] trace write failed:", (err as Error).message);
    }
  };

  try {
    const client = getClient();
    const { tools, dispatch } = await buildTools((toolSpecs ?? []) as ToolSpec[]);

    const base = {
      model,
      ...(typeof instructions === "string" && instructions.trim() ? { instructions } : {}),
      // Non-reasoning models reject the reasoning block outright, so only send it when asked for.
      ...(effort && effort !== "off" ? { reasoning: { effort } } : {}),
      ...(tools.length ? { tools } : {}),
    };

    let conversation: unknown[] = [{ role: "user", content: input }];
    const call = async (payload: Record<string, unknown>) => {
      const started = Date.now();
      const result = await client.responses.create(payload as never);
      rounds.push({
        request: payload,
        response: { output: result.output, usage: result.usage, model: result.model },
        ms: Date.now() - started,
      });
      return result;
    };

    let response = await call({ ...base, input: conversation });

    const toolCalls: { name: string; detail?: string; urls?: string[] }[] = [];
    const uniq = (urls: (string | null | undefined)[]) => [...new Set(urls.filter((u): u is string => !!u))];
    let usedIn = 0;
    let usedOut = 0;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      usedIn += response.usage?.input_tokens ?? 0;
      usedOut += response.usage?.output_tokens ?? 0;

      for (const item of response.output) {
        if (item.type !== "web_search_call") continue;
        // A search reports the query and the sources it turned up; open_page/find_in_page
        // report the single page they visited.
        const action = (item as {
          action?: {
            type?: string;
            query?: string;
            queries?: string[] | null;
            url?: string | null;
            sources?: { url?: string }[] | null;
          };
        }).action;
        // `queries` carries every query the model ran; `query` is the deprecated singular.
        const detail = action?.queries?.length ? action.queries.join(" · ") : action?.query;
        const urls = uniq([action?.url, ...(action?.sources ?? []).map((src) => src.url)]);
        toolCalls.push({
          name: `web_search${action?.type && action.type !== "search" ? `.${action.type}` : ""}`,
          detail,
          ...(urls.length ? { urls } : {}),
        });
      }

      const calls = response.output.filter((o) => o.type === "function_call");
      if (!calls.length) break;

      if (round === MAX_TOOL_ROUNDS) {
        throw new Error(`tool calls did not settle after ${MAX_TOOL_ROUNDS} rounds`);
      }

      // Reasoning items must be carried forward alongside the calls they belong to.
      conversation = [...conversation, ...response.output];

      for (const call of calls) {
        const { name, arguments: args, call_id } = call as unknown as {
          name: string;
          arguments: string;
          call_id: string;
        };
        toolCalls.push({ name, detail: args && args !== "{}" ? args : undefined });
        conversation.push({
          type: "function_call_output",
          call_id,
          output: await dispatch(name, args),
        });
      }

      response = await call({ ...base, input: conversation });
    }

    // Whatever the answer actually cites, gathered from the final message's annotations.
    const cited = uniq(
      response.output.flatMap((item) =>
        item.type === "message"
          ? item.content.flatMap((part) =>
              "annotations" in part
                ? (part.annotations ?? []).map((a) =>
                    a.type === "url_citation" ? a.url : undefined,
                  )
                : [],
            )
          : [],
      ),
    );
    if (cited.length) toolCalls.push({ name: "citations", urls: cited });

    const payload = {
      text: response.output_text ?? "",
      model: response.model ?? model,
      usage: { input: usedIn, output: usedOut },
      ...(toolCalls.length ? { toolCalls } : {}),
    };

    await save("ok", {
      servedModel: payload.model,
      outputText: payload.text,
      toolCalls,
      usage: payload.usage,
    });

    res.json(payload);
  } catch (err) {
    const e = err as { status?: number; message?: string };
    console.error("[mnemonic] run failed:", e.message);
    await save("error", { error: e.message ?? "request failed" });
    res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({
      error: e.message ?? "request failed",
    });
  }
});

app.get("/api/trace/runs", async (req, res) => {
  try {
    res.json({ runs: await listRuns(Number(req.query.limit) || 100) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/trace/runs/:runId", async (req, res) => {
  try {
    res.json({ steps: await getRun(req.params.runId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/trace/runs/:runId", async (req, res) => {
  try {
    await deleteRun(req.params.runId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => console.log(`[mnemonic] proxy listening on http://localhost:${PORT}`));
