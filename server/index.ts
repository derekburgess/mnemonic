import { reviewWorkspaceChanges, acceptWorkspaceChanges, workspaceChangesSummary } from "./workspaceChanges.js";
import { sandboxAdvice } from "./sandboxAdvice.js";
import { event, sanitize, redactText, errorDetail, type EmitEvent } from "./events.js";
import express from "express";
import { listLibrary, startDownload, cancelDownload, deleteDownload, modelDownloaded } from "./modelLibrary.js";
import { sweepLocalModels } from "./localModelContainer.js";
import { localActivity, localCompletion, withLocalModel } from "./localModels.js";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { ExecutionBudget, executionClient } from "./execution.js";
import { buildTools, listMcpTools, type ToolSpec } from "./tools.js";
import { deleteRun, getRun, getStepResult, listRuns, recordStep, recordEvent, markInterrupted, getRunProgress } from "./trace.js";
import { readSettings, publicSettings, PROVIDERS, resolveCredentials, writeSettings, sandboxModelUrl, type Provider } from "./settings.js";
import { loadGraph, saveGraph, graphDb } from "./graphstore.js";
import { TIMEOUT_MESSAGE, runChat, runResponses } from "./providers.js";
import { check, describeWorkspaces, findFolder, nativePick } from "./workspace.js";
import { mountsFor, runInSandbox, sandboxStatus, sweepOrphans, type Mount } from "./sandbox.js";
import type { Job } from "./runner.js";
import type { ContainerTrace } from "./containerTrace.js";

dotenv.config();

const PORT = Number(process.env.PORT ?? 8787);
const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));
// The listener starts only after startup recovery and cleanup finish.
app.get("/api/health", (_req, res) => res.json({ service: "mnemonic", status: "ready" }));

const MISSING_KEY = "No API key set. Add one in Settings, or put OPENAI_API_KEY in .env.";

if (!resolveCredentials().apiKey) console.warn(`[mnemonic] ${MISSING_KEY}`);

// Constructed lazily and rebuilt whenever the credentials change: the SDK throws on a missing
// key, and the UI is still worth serving so the graph can be built before a key is in place.
let cached: { client: OpenAI; signature: string } | null = null;
function getClient(provider?: Provider): OpenAI {
  const { apiKey, baseUrl } = resolveCredentials(provider);
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
app.get("/api/local-model/models", (_req, res) => res.json({ models: listLibrary(), activity: localActivity() }));
app.post("/api/local-model/download", (req, res) => {
  try { startDownload(req.body?.model); res.status(202).json({ accepted: true }); }
  catch (err) { res.status(400).json({ error: (err as Error).message }); }
});
app.post("/api/local-model/cancel", (req, res) => {
  try { cancelDownload(req.body?.model); res.json({ cancelling: true }); }
  catch (err) { res.status(400).json({ error: (err as Error).message }); }
});
app.delete("/api/local-model/models", async (req, res) => {
  try { await deleteDownload(req.body?.model); res.json({ deleted: true }); }
  catch (err) { res.status(409).json({ error: (err as Error).message }); }
});

app.get("/api/local-model/status", (_req, res) => res.json({ activity: localActivity() }));
app.post("/api/local-inference/chat/completions", async (req, res) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    res.json(await localCompletion(token, req.body ?? {}));
  } catch (err) { res.status(400).json({ error: { message: (err as Error).message } }); }
});

app.get("/api/settings", (req, res) => {
  const provider = req.query.provider as Provider | undefined;
  if (provider && !PROVIDERS.includes(provider)) return res.status(400).json({ error: "Unknown provider" });
  res.json(publicSettings(provider));
});

app.post("/api/settings", (req, res) => {
  const { apiKey, baseUrl, provider, runLocally } = req.body ?? {};
  if (runLocally !== undefined && typeof runLocally !== "boolean") return res.status(400).json({ error: "runLocally must be a boolean" });
  if (apiKey !== undefined && typeof apiKey !== "string") {
    return res.status(400).json({ error: "apiKey must be a string" });
  }
  if (provider !== undefined && !["openai", "compatible", "huggingface"].includes(provider)) {
    return res.status(400).json({ error: "Unknown provider" });
  }
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch { return res.status(400).json({ error: "Base URL must be an HTTP or HTTPS URL" }); }
  }
  try {
    writeSettings({
      ...(runLocally !== undefined ? { runLocally } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(baseUrl !== undefined ? { baseUrl: String(baseUrl) } : {}),
      ...(provider !== undefined ? { provider: provider as Provider } : {}),
    }, false);
    res.json(publicSettings(provider));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/models", async (req, res) => {
  const provider = (req.query.provider ?? readSettings().provider ?? "openai") as Provider;
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: "Unknown provider" });
  if (provider === "huggingface" && readSettings().runLocally) return res.json({ models: listLibrary().filter((model) => model.status === "Downloaded").map((model) => model.model) });
  try {
    const list = await getClient(provider).models.list();
    // Another provider's catalogue is its own; curating it against OpenAI's naming would
    // throw away everything it offers.
    const ids =
      provider !== "openai"
        ? list.data.map((m) => m.id).sort()
        : usableModels(list.data);
    res.json({ models: ids.length ? ids : provider === "openai" ? FALLBACK_MODELS : [] });
  } catch (err) {
    console.warn("[mnemonic] model listing failed, serving fallback list:", (err as Error).message);
    res.json({ models: provider === "openai" ? FALLBACK_MODELS : [], fallback: true });
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

app.post("/api/sandbox/recommend", async (req, res) => {
  const { provider, model, configuration, instructions } = req.body ?? {};
  if (!PROVIDERS.includes(provider) || typeof model !== "string" || !model.trim() ||
      typeof configuration !== "string" || typeof instructions !== "string" || !instructions.trim()) {
    return res.status(400).json({ error: "Choose a provider and model, and enter instructions." });
  }
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    const address = server.address();
    const text = await sandboxAdvice({ provider, model, configuration, instructions }, controller.signal,
      typeof address === "object" && address ? address.port : PORT);
    res.json({ text });
  } catch (err) {
    if (!res.destroyed) res.status(400).json({ error: redactText((err as Error).message, PROVIDERS.map((id) => resolveCredentials(id).apiKey)) });
  }
});

/** Whether a step could be contained here, so the toggle can disable itself with a reason. */
app.get("/api/sandbox", async (_req, res) => {
  res.json({ ...await sandboxStatus(), gpuSupported: process.platform !== "darwin" });
});

/**
 * Opens the desktop's own folder chooser and answers with the path it returned. This is the
 * whole reason the proxy is involved: no browser API reports where a chosen folder is, and this
 * one does, exactly and without enumerating anything.
 */
app.post("/api/fs/pick", async (req, res) => {
  const { start } = req.body ?? {};
  try {
    res.json(await nativePick(typeof start === "string" ? start : undefined));
  } catch (err) {
    const e = err as Error & { status?: number };
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

/**
 * The fallback path, for a proxy that has no desktop of its own: the browser's own picker gives
 * a folder's name and the entries inside it, and this finds the folder from those. A suggestion
 * for an editable field, never something acted on unseen.
 */
app.post("/api/fs/resolve", async (req, res) => {
  const { name, entries } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    const contains = Array.isArray(entries)
      ? entries.filter((e: unknown): e is string => typeof e === "string")
      : [];
    res.json({ matches: await findFolder(name, contains) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Backs the workspace path field: is this really a folder here, and what completes it? */
app.get("/api/fs/check", async (req, res) => {
  const path = typeof req.query.path === "string" ? req.query.path : "";
  try {
    res.json(await check(path));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * One step, executed in a container, shaped so the caller cannot tell the difference.
 *
 * The rounds the container collected are pushed into the same array an uncontained run fills,
 * so the trace records a contained step just as completely — including the rounds leading up to
 * a failure, which is when they are worth the most.
 */
async function runContained(args: {
  job: Job;
  sandboxConfig?: string;
  mounts: Mount[];
  budgetSec: number;
  rounds: unknown[];
  onTrace: (trace: ContainerTrace) => void;
  onChanges: (id?: string) => void;
  onEvent: EmitEvent;
  signal: AbortSignal;
}) {
  // Checked here rather than left to the container: a missing key should read the same whether
  // or not the step is contained, instead of surfacing as a container that exited oddly.
  if (!args.job.apiKey) throw Object.assign(new Error(MISSING_KEY), { status: 401 });

  const job = args.job.provider === "huggingface" && args.job.baseUrl
    ? { ...args.job, baseUrl: sandboxModelUrl(args.job.baseUrl) }
    : args.job;
  const { result, stderr, workspaceChanges } = await runInSandbox(job, args.mounts, {
    sandboxConfig: args.sandboxConfig,
    timeoutSec: args.budgetSec,
    onTrace: args.onTrace,
    onEvent: args.onEvent,
    signal: args.signal,
  });
  args.rounds.push(...result.rounds);
  args.onChanges(workspaceChanges);

  if (!result.ok) {
    if (stderr.trim()) console.error("[mnemonic] sandbox stderr:", stderr.trim().slice(-2000));
    throw Object.assign(new Error(result.error), { status: result.status });
  }
  return result.result;
}

type ActiveExecution = { controller: AbortController; ready: Promise<boolean>; accept: (ready: boolean) => void };
const activeExecutions = new Map<string, ActiveExecution>();
const executionKey = (runId: string, execId: string) => `${runId}/${execId}`;

app.get("/api/executions/:runId/:execId", async (req, res) => {
  try { const result = await getStepResult(req.params.runId, req.params.execId);
    res.status(result ? 200 : 404).json(result ?? { error: "Execution was not accepted by the server." });
  } catch (err) { res.status(503).json({ error: (err as Error).message }); }
});
app.post("/api/executions/:runId/:execId/cancel", async (req, res) => {
  const execution = activeExecutions.get(executionKey(req.params.runId, req.params.execId));
  execution?.controller.abort();
  res.json({ cancelling: !!execution });
});

app.post("/api/run", async (req, res) => {
  const { model, effort, input, instructions, tools: toolSpecs, maxRounds, timeoutSec, files, links, workspaces, workspaceTools, sandbox, sandboxConfig, useGpu, trace: suppliedTrace } =
    req.body ?? {};

  if (typeof model !== "string" || typeof input !== "string" || !input.trim()) {
    return res.status(400).json({ error: "model and a non-empty input are required" });
  }

  if (timeoutSec !== undefined && (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec * 1000 > 2_147_483_647)) return res.status(400).json({ error: "timeoutSec must be a positive finite duration" });

  if (sandboxConfig !== undefined && typeof sandboxConfig !== "string") return res.status(400).json({ error: "sandboxConfig must be JSON text" });
  if (useGpu !== undefined && typeof useGpu !== "boolean") return res.status(400).json({ error: "useGpu must be a boolean" });

  const trace = { ...suppliedTrace, runId: suppliedTrace?.runId ?? crypto.randomUUID(), execId: suppliedTrace?.execId ?? crypto.randomUUID() };
  if (typeof trace.runId !== "string" || trace.runId.length > 200 || typeof trace.execId !== "string" || trace.execId.length > 200) {
    return res.status(400).json({ error: "Invalid execution identity" });
  }
  const roots: string[] = Array.isArray(workspaces)
    ? workspaces.filter((w: unknown): w is string => typeof w === "string" && !!w.trim())
    : [];

  // A contained step sees its workspaces where they are mounted, not where they live on the
  // host. Naming is shared with the tools, so a prompt reads the same either way -- only the
  // location behind the name changes, and the host's directory shape stays out of the prompt.
  const selectedProvider = req.body?.provider;
  if (selectedProvider !== undefined && !PROVIDERS.includes(selectedProvider)) return res.status(400).json({ error: "Unknown provider" });
  const credentials = resolveCredentials(selectedProvider);
  const managedLocal = credentials.provider === "huggingface" && !!readSettings().runLocally;
  const contained = managedLocal || sandbox === true;
  const mounts = contained ? mountsFor(roots) : [];
  const visibleRoots = contained ? mounts.map((m) => m.container) : roots;

  // Named roots are only known once the paths are resolved, so the workspace preamble is
  // appended here rather than composed in the browser -- and the trace records what was sent.
  const preamble = describeWorkspaces(visibleRoots, workspaceTools ?? {});
  const system = [typeof instructions === "string" ? instructions : "", preamble ?? ""]
    .filter((part) => part.trim())
    .join("\n\n");

  const startedMs = Date.now();
  /** Every request/response pair in the tool loop, kept verbatim for the trace. */
  const rounds: unknown[] = [];
  let container: ContainerTrace | null = null;

  const secrets = [credentials.apiKey, ...(toolSpecs ?? []).flatMap((t: ToolSpec) =>
    t.kind === "mcp" && t.authorization ? [t.authorization, t.authorization.replace(/^Bearer\s+/i, "")] : [])];
  const execId = trace?.execId ?? `${trace?.runId}-${trace?.seq ?? 0}`;
  let writes = Promise.resolve();
  let eventCount = 0;
  const emit: EmitEvent = (entry) => {
    if (!trace?.runId) return;
    if (++eventCount > 2000 && !/^(execution\.|result\.|container\.(exited|cleanup)|workspace\.|response\.|local\.(error|ready|unloading|unloaded|worker_exited))/.test(entry.kind)) return;
    const safe = { ...entry, detail: sanitize(entry.detail, secrets) };
    writes = writes.then(() => recordEvent(trace.runId, execId, safe))
      .catch((err) => console.error("[mnemonic] trace event write failed:", (err as Error).message));
  };
  let workspaceChanges: string | undefined;
  const save = async (status: "running" | "ok" | "error" | "cancelled", extra: Record<string, unknown>) => {
    if (!trace?.runId) return false;
    try {
      await recordStep({
        execId,
        runId: trace.runId,
        kind: trace.kind ?? "run",
        seq: trace.seq ?? 0,
        nodeId: trace.nodeId ?? "",
        label: trace.label ?? "",
        requestedModel: model,
        effort: effort ?? "off",
        startedMs,
        finishedMs: status === "running" ? null : Date.now(),
        status,
        systemPrompt: sanitize(system || null, secrets, 65_536) as string | null,
        inputPrompt: sanitize(input, secrets, 65_536) as string,
        context: Array.isArray(trace.context) ? trace.context.slice(0, 100).map((x: unknown) => sanitize(x, secrets)) : null,
        // Workspace tools are derived rather than configured, so they are recorded as one
        // synthetic entry instead of being invisible in the trace.
        tools: [
          ...(toolSpecs ?? []).slice(0, 100).map((x: unknown) => sanitize(x, secrets)),
          ...(roots.length ? [{ kind: "workspace", roots, enabled: workspaceTools ?? {} }] : []),
          ...(contained
            ? [{ kind: "sandbox", mounts: mounts.map((m) => `${m.host} (disposable copy) -> ${m.container}`) }]
            : []),
        ],
        rounds: rounds.slice(-100).map((x) => sanitize(x, secrets, 32_768)),
        container,
        params: {
          workspaceChanges,
          sandboxConfig: sandboxConfig ?? null,
          maxRounds: typeof maxRounds === "number" ? maxRounds : null,
          timeoutSec: typeof timeoutSec === "number" ? timeoutSec : null,
          deliveryTimeoutSec: typeof timeoutSec === "number" && timeoutSec > 0 ? timeoutSec + (contained ? 720 : 60) : 300 + (contained ? 720 : 60),
        },
        // Sizes rather than payloads: the bytes are already elided from the rounds.
        files: Array.isArray(files)
          ? files.map((f: { name?: string; mime?: string; dataUrl?: string }) => ({
              name: f.name,
              mime: f.mime,
              bytes: Math.round(((f.dataUrl?.length ?? 0) - (f.dataUrl?.indexOf(",") ?? 0) - 1) * 0.75),
            }))
          : [],
        links: Array.isArray(links) ? links.map((url: string) => ({ url, kind: "pending" })) : [],
        servedModel: null,
        error: null,
        toolCalls: null,
        outputText: null,
        usage: null,
        ...extra,
      });
      return true;
    } catch (err) {
      // A trace failure must never take a run down with it.
      console.error("[mnemonic] trace write failed:", (err as Error).message);
      return false;
    }
  };

  const key = executionKey(trace.runId, execId);
  const existing = activeExecutions.get(key);
  const acknowledgement = { runId: trace.runId, execId, status: "accepted" };
  if (existing) {
    return (await existing.ready) ? res.status(202).json(acknowledgement) : res.status(503).json({ error: "Could not persist execution" });
  }
  let accept!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { accept = resolve; });
  const controller = new AbortController();
  activeExecutions.set(key, { controller, ready, accept });
  try {
    if (await getStepResult(trace.runId, execId)) {
      accept(true); activeExecutions.delete(key);
      return res.status(202).json(acknowledgement);
    }
  } catch (err) {
    accept(false); activeExecutions.delete(key);
    return res.status(503).json({ error: (err as Error).message });
  }
  if (!(await save("running", {}))) {
    accept(false); activeExecutions.delete(key);
    return res.status(503).json({ error: "Could not persist execution; the model was not started." });
  }
  accept(true);
  if (Number.isFinite(trace?.clientSentMs)) emit({ ...event("browser", "request.sent"), at: trace.clientSentMs });
  emit(event("proxy", "request.accepted", { executionTimeoutSec: timeoutSec > 0 ? timeoutSec : 300,
    deliveryTimeoutSec: (timeoutSec > 0 ? timeoutSec : 300) + (contained ? 720 : 60) }));
  await writes;
  res.on("close", () => {
    if (!res.writableFinished) emit(event("proxy", "delivery.connection_closed", { executionContinues: true }));
  });
  res.on("finish", () => emit(event("proxy", "response.sent", { status: res.statusCode })));
  res.status(202).json(acknowledgement);
  const budget = new ExecutionBudget(timeoutSec ?? 300, controller.signal);
  emit(event("proxy", "execution.budget", { deadlineMs: budget.deadlineMs, timeoutSec: timeoutSec ?? 300 }));
  try {
    controller.signal.throwIfAborted();
    const { provider } = credentials;
    if (managedLocal) {
      if (!modelDownloaded(model)) throw new Error("Download this model in Settings > Hugging Face before running the node.");
      const docker = await budget.wait(sandboxStatus(budget.signal));
      if (!docker.available) throw new Error(`Local model mode requires Docker. ${docker.reason}`);
    }
    // The browser has its own deadline, but the server needs one too or an abandoned run keeps
    // calling the model after the node has given up on it.
    const budgetSec = typeof timeoutSec === "number" && timeoutSec > 0 ? timeoutSec : 300;
    const cleanLinks = Array.isArray(links)
      ? links.filter((l: unknown): l is string => typeof l === "string" && !!l.trim())
      : undefined;

    const localSignal = budget.signal;
    const execute = async ({ apiKey, baseUrl }: { apiKey: string; baseUrl?: string }) => contained
      ? await runContained({
          job: {
            apiKey,
            baseUrl,
            provider,
            model,
            effort,
            input,
            instructions: system || undefined,
            tools: (toolSpecs ?? []) as ToolSpec[],
            maxRounds: typeof maxRounds === "number" ? maxRounds : undefined,
            timeoutSec: budgetSec,
            deadlineMs: budget.deadlineMs,
            managedLocal,
            files: Array.isArray(files) ? files : undefined,
            links: cleanLinks,
            workspaces: visibleRoots,
            workspaceTools: workspaceTools ?? {},
          },
          mounts,
          sandboxConfig,
          budgetSec,
          rounds,
          onTrace: (trace) => { container = trace; },
          onChanges: (id) => { workspaceChanges = id; },
          onEvent: emit,
          signal: budget.signal,
        })
      : await (async () => {
          const client = executionClient({ apiKey, baseUrl }, budget, managedLocal);
          emit(event("proxy", "tools.preparing"));
          const { tools, dispatch } = await budget.wait(buildTools((toolSpecs ?? []) as ToolSpec[], roots, emit, budget, workspaceTools ?? {}));
          const run = provider !== "openai" ? runChat : runResponses;
          return budget.wait(run({
            signal: budget.signal,
            client,
            transport: budget.fetch,
            model,
            effort,
            input,
            instructions: system || undefined,
            tools,
            dispatch,
            maxRounds: typeof maxRounds === "number" ? maxRounds : undefined,
            files: Array.isArray(files) ? files : undefined,
            links: cleanLinks,
            onEvent: emit,
            onRound: (round) => { rounds.push(round); emit(event("proxy", "round.recorded", { round: rounds.length, ...round })); },
          }));
        })();
    const address = server.address();
    const result = managedLocal
      ? await withLocalModel({ model, nodeId: trace.nodeId, token: credentials.source === "none" ? undefined : credentials.apiKey,
          signal: localSignal, useGpu: useGpu === true, sandboxConfig, emit }, execute,
          typeof address === "object" && address ? address.port : PORT)
      : await execute(credentials);

    const payload = {
      text: result.text,
      model: result.model,
      usage: result.usage,
      ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
    };

    emit(event("proxy", "execution.completed"));
    await writes;
    const saved = await save("ok", {
      servedModel: payload.model,
      outputText: redactText(payload.text, secrets),
      toolCalls: result.toolCalls.slice(0, 200).map((x) => sanitize(x, secrets)),
      usage: payload.usage,
      // The composed input is what was actually sent, inlined files and link text included.
      inputPrompt: sanitize(result.composedInput, secrets, 65_536),
      ...(result.links.length ? { links: result.links.map((x) => sanitize(x, secrets)) } : {}),
    });

    emit(event("proxy", saved ? "result.saved" : "result.persistence_failed"));
    await writes;
  } catch (err) {
    const raw = err as { status?: number; message?: string; name?: string };
    const e = Object.assign(new Error(raw.message ?? "request failed", { cause: err }), { name: raw.name ?? "Error", status: raw.status });
    // The SDK reports its own abort as "Request was aborted."; make every route to a spent
    // budget report the same thing.
    if (controller.signal.aborted) { e.message = "cancelled"; e.status = 409; }
    else if (budget.signal.aborted || /abort|timeout/i.test(`${e.name} ${e.message}`)) {
      e.message = TIMEOUT_MESSAGE;
      e.status = 504;
    }
    console.error("[mnemonic] run failed:", e.message);
    emit(event("proxy", "execution.failed", { error: errorDetail(e) }));
    await writes;
    await save(controller.signal.aborted ? "cancelled" : "error", { error: sanitize(e.message ?? "request failed", secrets) });
  } finally {
    await budget.dispose();
    activeExecutions.delete(key);
  }
});

app.get("/api/workspace-changes/:id/summary", async (req, res) => {
  try { res.json(await workspaceChangesSummary(req.params.id)); }
  catch (err) { res.status((err as {status?: number}).status ?? 500).json({ error: (err as Error).message }); }
});
app.get("/api/workspace-changes/:id", async (req, res) => {
  try { res.json(await reviewWorkspaceChanges(req.params.id)); }
  catch (err) { res.status((err as {status?: number}).status ?? 500).json({ error: (err as Error).message }); }
});
app.post("/api/workspace-changes/:id/accept", async (req, res) => {
  try { res.json(await acceptWorkspaceChanges(req.params.id, req.body?.files)); }
  catch (err) { res.status((err as {status?: number}).status ?? 500).json({ error: (err as Error).message }); }
});

app.get("/api/graph", async (_req, res) => {
  try {
    res.json(await loadGraph());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.put("/api/graph", async (req, res) => {
  const { nodes, edges, expectedRevision } = req.body ?? {};
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return res.status(400).json({ error: "nodes and edges arrays are required" });
  }
  if (expectedRevision !== null && typeof expectedRevision !== "number") return res.status(428).json({ error: "Graph revision is required; refresh the app." });
  try {
    res.json({ updatedMs: await saveGraph(nodes, edges, expectedRevision) });
  } catch (err) {
    res.status((err as {status?: number}).status ?? 500).json({ error: (err as Error).message });
  }
});

const browserKinds = new Set(["delivery.recovering", "delivery.poll", "delivery.poll_failed", "delivery.recovered",
  "delivery.received", "delivery.failed", "delivery.cancelled", "delivery.headers", "delivery.body_failed",
  "graph.committed", "graph.failed"]);
app.post("/api/trace/events", async (req, res) => {
  const { runId, execId, events } = req.body ?? {};
  if (typeof runId !== "string" || runId.length > 200 || typeof execId !== "string" || execId.length > 200 ||
      !Array.isArray(events) || events.length > 100 || events.some((e) => !e ||
      typeof e.id !== "string" || e.id.length > 100 || !Number.isFinite(e.at) || !browserKinds.has(e.kind))) {
    return res.status(400).json({ error: "Invalid trace events" });
  }
  try {
    for (const entry of events) await recordEvent(runId, execId, { ...entry, source: "browser",
      detail: sanitize(entry.detail, PROVIDERS.map((provider) => resolveCredentials(provider).apiKey)) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/trace/runs", async (req, res) => {
  try {
    res.json({ runs: await listRuns(Number(req.query.limit) || 100) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * The result of one step execution on its own. A run whose HTTP response never arrived is
 * collected from here instead: the work finished, only the delivery failed.
 */
app.get("/api/trace/result/:runId/:execId", async (req, res) => {
  try {
    const row = await getStepResult(req.params.runId, req.params.execId);
    res.json(row ?? { status: "pending" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/trace/runs/:runId/progress", async (req, res) => {
  try { res.json(await getRunProgress(req.params.runId, Number(req.query.after) || 0)); }
  catch (err) { res.status(500).json({ error: (err as Error).message }); }
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

await graphDb().catch((err) => console.error("[mnemonic] graph initialization failed:", err.message));
await markInterrupted().catch((err) => console.error("[mnemonic] trace recovery failed:", err.message));


// A previous life of this process may have been killed mid-step -- `tsx watch` restarts on every
// save -- and a container outlives the client that started it. Whatever it left is removed here.
await sweepLocalModels().catch((err) => console.warn("[mnemonic] local model cleanup:", err.message));
await sweepOrphans().then((n) => {
  if (n) console.log(`[mnemonic] removed ${n} orphaned sandbox container(s) from a previous run`);
});

const server = app.listen(PORT, () => {
  const address = server.address();
  console.log(`[mnemonic] proxy listening on http://localhost:${typeof address === "object" && address ? address.port : PORT}`);
});
