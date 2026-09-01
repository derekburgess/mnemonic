import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { buildTools, listMcpTools, type ToolSpec } from "./tools.js";
import { deleteRun, getRun, listRuns, recordStep } from "./trace.js";
import { readSettings, resolveCredentials, writeSettings, type Provider } from "./settings.js";
import { TIMEOUT_MESSAGE, runChat, runResponses } from "./providers.js";

dotenv.config();

const PORT = Number(process.env.PORT ?? 8787);
const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const MISSING_KEY = "No API key set. Add one in Settings, or put OPENAI_API_KEY in .env.";

if (resolveCredentials().source === "none") console.warn(`[mnemonic] ${MISSING_KEY}`);

// Constructed lazily and rebuilt whenever the credentials change: the SDK throws on a missing
// key, and the UI is still worth serving so the graph can be built before a key is in place.
let cached: { client: OpenAI; signature: string } | null = null;
function getClient(): OpenAI {
  const { apiKey, baseUrl } = resolveCredentials();
  if (!apiKey) throw Object.assign(new Error(MISSING_KEY), { status: 401 });

  const signature = `${apiKey}::${baseUrl ?? ""}`;
  if (cached?.signature !== signature) {
    cached = { client: new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) }), signature };
  }
  return cached.client;
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

/** The key itself is never sent back to the browser, only whether one is configured. */
app.get("/api/settings", (_req, res) => {
  const { source, baseUrl, provider } = resolveCredentials();
  res.json({ keySource: source, baseUrl: baseUrl ?? "", provider, hasPanelKey: !!readSettings().apiKey });
});

app.post("/api/settings", (req, res) => {
  const { apiKey, baseUrl, provider } = req.body ?? {};
  if (apiKey !== undefined && typeof apiKey !== "string") {
    return res.status(400).json({ error: "apiKey must be a string" });
  }
  try {
    writeSettings({
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(baseUrl !== undefined ? { baseUrl: String(baseUrl) } : {}),
      ...(provider !== undefined ? { provider: provider as Provider } : {}),
    });
    const { source, baseUrl: url, provider: p } = resolveCredentials();
    res.json({ keySource: source, baseUrl: url ?? "", provider: p, hasPanelKey: !!readSettings().apiKey });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/models", async (_req, res) => {
  try {
    const list = await getClient().models.list();
    // Another provider's catalogue is its own; curating it against OpenAI's naming would
    // throw away everything it offers.
    const ids =
      resolveCredentials().provider === "compatible"
        ? list.data.map((m) => m.id).sort()
        : usableModels(list.data);
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

app.post("/api/run", async (req, res) => {
  const { model, effort, input, instructions, tools: toolSpecs, maxRounds, timeoutSec, trace } =
    req.body ?? {};
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
    const { provider } = resolveCredentials();
    const { tools, dispatch } = await buildTools((toolSpecs ?? []) as ToolSpec[]);

    // The browser has its own deadline, but the server needs one too or an abandoned run keeps
    // calling the model after the node has given up on it.
    const budgetSec = typeof timeoutSec === "number" && timeoutSec > 0 ? timeoutSec : 300;

    const run = provider === "compatible" ? runChat : runResponses;
    const result = await run({
      signal: AbortSignal.timeout(budgetSec * 1000),
      client,
      model,
      effort,
      input,
      instructions: typeof instructions === "string" ? instructions : undefined,
      tools,
      dispatch,
      maxRounds: typeof maxRounds === "number" ? maxRounds : undefined,
      onRound: (round) => rounds.push(round),
    });

    const payload = {
      text: result.text,
      model: result.model,
      usage: result.usage,
      ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
    };

    await save("ok", {
      servedModel: payload.model,
      outputText: payload.text,
      toolCalls: result.toolCalls,
      usage: payload.usage,
    });

    res.json(payload);
  } catch (err) {
    const e = err as { status?: number; message?: string; name?: string };
    // The SDK reports its own abort as "Request was aborted."; make every route to a spent
    // budget report the same thing.
    if (/abort|timeout/i.test(`${e.name} ${e.message}`)) {
      e.message = TIMEOUT_MESSAGE;
      e.status = 504;
    }
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
