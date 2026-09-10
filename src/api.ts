import { reportTraceEvent } from "./traceEvents";
import type { TraceEvent } from "../server/events";
import type { Effort, ToolCallRecord, ToolConfig } from "./types";
import type { ContainerTrace } from "../server/containerTrace";

const FALLBACK_MODELS = ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4o", "gpt-4o-mini"];

export async function fetchModels(): Promise<string[]> {
  try {
    const res = await fetch("/api/models");
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    return Array.isArray(body.models) && body.models.length ? body.models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

export type RunResponse = {
  text: string;
  model: string;
  usage?: { input?: number; output?: number };
  toolCalls?: ToolCallRecord[];
};

export type McpTool = { name: string; description: string; inputSchema: Record<string, unknown> };

export async function fetchMcpTools(
  serverUrl: string,
  authorization?: string,
): Promise<{ tools: McpTool[]; resolvedUrl: string }> {
  const res = await fetch("/api/mcp/tools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverUrl, authorization }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return { tools: body.tools ?? [], resolvedUrl: body.resolvedUrl ?? serverUrl };
}

/** Flatten a step's tool into the shape the proxy expects. */
export function toolSpec(d: ToolConfig): Record<string, unknown> {
  if (d.kind === "web_search") {
    return { kind: "web_search", contextSize: d.contextSize, allowedDomains: d.allowedDomains };
  }
  if (d.kind === "mcp") {
    return {
      kind: "mcp",
      label: d.label || "mcp",
      serverUrl: d.serverUrl ?? "",
      authorization: d.authorization,
      selectedTools: d.selectedTools ?? [],
      timeoutSec: d.timeoutSec,
    };
  }
  return {
    kind: "custom",
    fnName: d.fnName || "custom_tool",
    fnDescription: d.fnDescription,
    fnParameters: d.fnParameters,
    fnCode: d.fnCode,
    timeoutSec: d.timeoutSec,
  };
}

export type SandboxStatus = { available: boolean; runtime?: string; version?: string; reason?: string };

/** Whether the proxy could run a step in a container, so the toggle can say why not. */
export async function fetchSandboxStatus(): Promise<SandboxStatus> {
  try {
    const res = await fetch("/api/sandbox");
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch {
    return { available: false, reason: "Could not reach the proxy to ask about containers." };
  }
}

export type NativePick = { path?: string; cancelled?: boolean; unavailable?: boolean };

/**
 * Opens the desktop's folder chooser through the proxy. This is the only route that yields a
 * real absolute path; everything else is inference.
 */
export async function pickFolderNatively(start?: string): Promise<NativePick> {
  const res = await fetch("/api/fs/pick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start }),
  });
  if (res.status === 501) return { unavailable: true };
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `could not open a folder chooser (${res.status})`);
  return body;
}

export type FolderMatch = { path: string; score: number };

/**
 * Ask the proxy where a folder the OS dialog just chose actually lives. The browser only ever
 * learns the folder's name and what is directly inside it, so that is what gets sent.
 */
export async function resolveFolder(name: string, entries: string[]): Promise<FolderMatch[]> {
  const res = await fetch("/api/fs/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, entries }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `could not locate that folder (${res.status})`);
  return body.matches ?? [];
}

export type PathCheck = { exists: boolean; dir: boolean; suggestions: string[] };

/**
 * Whether a typed or resolved path is really a folder on the machine running the proxy, and
 * what it could be completed to. One request, because the field asks for both together.
 */
export async function checkPath(path: string): Promise<PathCheck> {
  const res = await fetch(`/api/fs/check?path=${encodeURIComponent(path)}`);
  if (!res.ok) return { exists: false, dir: false, suggestions: [] };
  const body = await res.json();
  return { exists: !!body.exists, dir: !!body.dir, suggestions: body.suggestions ?? [] };
}

export type StoredGraph = { nodes: unknown[]; edges: unknown[]; updatedMs: number } | null;

export async function fetchGraph(): Promise<StoredGraph> {
  const res = await fetch("/api/graph", { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`could not load the graph (${res.status})`);
  return res.json();
}

export async function pushGraph(nodes: unknown[], edges: unknown[], expectedRevision: number | null): Promise<number> {
  const res = await fetch("/api/graph", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes, edges, expectedRevision }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error ?? `could not save the graph (${res.status})`), { status: res.status });
  return body.updatedMs;
}

export type Provider = "openai" | "compatible";

export type PlatformSettings = {
  /** Where the key in use came from; the key itself never leaves the server. */
  keySource: "panel" | "env" | "none";
  baseUrl: string;
  provider: Provider;
  hasPanelKey: boolean;
};

export async function fetchSettings(): Promise<PlatformSettings> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(`could not load settings (${res.status})`);
  return res.json();
}

export async function saveSettings(patch: {
  apiKey?: string;
  baseUrl?: string;
  provider?: Provider;
}): Promise<PlatformSettings> {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `could not save settings (${res.status})`);
  return body;
}

export type TraceMeta = {
  clientSentMs?: number;
  runId: string;
  execId: string;
  kind: "run" | "next" | "step";
  seq: number;
  nodeId: string;
  label: string;
  context: { label: string; text: string }[];
};

export type TraceRun = {
  running?: number;
  runId: string;
  kind: string;
  startedMs: number;
  finishedMs: number;
  steps: number;
  errors: number;
  models: string;
};

export type TraceStep = {
  runId: string;
  events: TraceEvent[];
  delivery: string;
  container: ContainerTrace | null;
  execId: string;
  seq: number;
  nodeId: string;
  label: string;
  requestedModel: string;
  servedModel: string | null;
  effort: string;
  startedMs: number;
  finishedMs: number | null;
  status: string;
  error: string | null;
  systemPrompt: string | null;
  inputPrompt: string;
  context: { label: string; text: string }[] | null;
  tools: Record<string, unknown>[] | null;
  rounds: { request: Record<string, unknown>; response: Record<string, unknown>; ms: number }[] | null;
  toolCalls: ToolCallRecord[] | null;
  outputText: string | null;
  usage: { input?: number; output?: number } | null;
  params: { maxRounds: number | null; timeoutSec: number | null; deliveryTimeoutSec?: number } | null;
  files: { name: string; mime: string; bytes: number }[] | null;
  links: { url: string; kind: string; note?: string }[] | null;
};

export type StepResult = {
  status: string;
  error: string | null;
  model: string;
  text: string;
  usage?: { input?: number; output?: number };
  toolCalls?: ToolCallRecord[];
};

/** One step execution's result, without the rounds — small enough to poll while waiting. */
export async function fetchStepResult(runId: string, execId: string, signal?: AbortSignal): Promise<StepResult | null> {
  const res = await fetch(
    `/api/trace/result/${encodeURIComponent(runId)}/${encodeURIComponent(execId)}`,
    { signal },
  );
  if (!res.ok) throw new Error(`could not read the step result (${res.status})`);
  return res.json();
}

export async function fetchTraceRuns(): Promise<TraceRun[]> {
  const res = await fetch("/api/trace/runs");
  if (!res.ok) throw new Error(`could not load runs (${res.status})`);
  return (await res.json()).runs ?? [];
}

export async function fetchTraceRun(runId: string): Promise<TraceStep[]> {
  const res = await fetch(`/api/trace/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) throw new Error(`could not load run (${res.status})`);
  return (await res.json()).steps ?? [];
}

export async function deleteTraceRun(runId: string): Promise<void> {
  const res = await fetch(`/api/trace/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`could not delete run (${res.status})`);
}

/** Used when a step does not set its own budget. */
export const DEFAULT_STEP_TIMEOUT_SEC = 300;

export async function runStep(
  args: {
    model: string;
    effort: Effort;
    input: string;
    instructions?: string;
    tools?: Record<string, unknown>[];
    maxRounds?: number;
    timeoutSec?: number;
    files?: { name: string; mime: string; dataUrl: string }[];
    links?: string[];
    workspaces?: string[];
    sandbox?: boolean;
    trace?: TraceMeta;
  },
  signal?: AbortSignal,
): Promise<RunResponse> {
  const trace = args.trace ?? { runId: crypto.randomUUID(), execId: crypto.randomUUID(), kind: "step" as const,
    seq: 0, nodeId: "", label: "", context: [] };
  const budget = args.timeoutSec && args.timeoutSec > 0 ? args.timeoutSec : DEFAULT_STEP_TIMEOUT_SEC;
  const deadline = Date.now() + (budget + (args.sandbox ? 720 : 60)) * 1000;
  const cancel = () => { reportTraceEvent(trace, "delivery.cancelled"); void cancelExecution(trace); };
  if (signal?.aborted) throw new Error("cancelled");
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    // Retrying admission with the same identity cannot execute the model twice.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...args, trace: { ...trace, clientSentMs: Date.now() } }), signal: AbortSignal.timeout(15_000) });
        const body = await response.json();
        if (!response.ok) throw Object.assign(new Error(body.error ?? `request failed (${response.status})`), { authoritative: true, terminal: true });
        if (response.status !== 202 || body.execId !== trace.execId || body.runId !== trace.runId) throw new Error("Invalid execution acknowledgement");
        reportTraceEvent(trace, "delivery.headers", { status: 202, attempt });
        break;
      } catch (err) {
        if ((err as { authoritative?: boolean }).authoritative) throw err;
        reportTraceEvent(trace, "delivery.failed", { phase: "admission", attempt, error: (err as Error).message });
        if (signal?.aborted) break;
        if (attempt < 3) await pause(500, signal);
      }
    }
    if (signal?.aborted) { await cancelExecution(trace); throw new Error("cancelled"); }
    return await waitForExecution(trace, { deadline, signal });
  } finally { signal?.removeEventListener("abort", cancel); }
}

export async function cancelExecution(trace: { runId: string; execId: string }): Promise<void> {
  try { await fetch(`/api/executions/${encodeURIComponent(trace.runId)}/${encodeURIComponent(trace.execId)}/cancel`,
    { method: "POST", signal: AbortSignal.timeout(5000) }); } catch { /* Recovery will still show the server's state. */ }
}

export async function fetchExecution(trace: {runId: string; execId: string}, signal?: AbortSignal): Promise<StepResult> {
  const res = await fetch(`/api/executions/${encodeURIComponent(trace.runId)}/${encodeURIComponent(trace.execId)}`, { signal });
  if (!res.ok) throw Object.assign(new Error((await res.json()).error ?? `Execution lookup failed (${res.status})`), { status: res.status });
  return res.json();
}

export async function waitForExecution(trace: {runId: string; execId: string}, options: { deadline: number; signal?: AbortSignal }): Promise<RunResponse> {
  let misses = 0;
  const started = Date.now();
  let attempt = 0;
  while (Date.now() < options.deadline) {
    if (options.signal?.aborted) throw new Error("cancelled");
    let result: StepResult | undefined;
    try {
      reportTraceEvent(trace, "delivery.poll", { attempt: ++attempt });
      const timeout = AbortSignal.timeout(10_000);
      result = await fetchExecution(trace, options.signal ? AbortSignal.any([options.signal, timeout]) : timeout);
    } catch (err) {
      if (options.signal?.aborted) throw new Error("cancelled");
      reportTraceEvent(trace, "delivery.poll_failed", { error: (err as Error).message });
      if ((err as {status?: number}).status === 404 && ++misses >= 3) throw Object.assign(err as Error, { terminal: true });
    }
    if (result?.status === "error") {
      reportTraceEvent(trace, "delivery.received", { executionStatus: "error" });
      throw Object.assign(new Error(result.error ?? "Execution failed"), { terminal: true });
    }
    if (result?.status === "ok") {
      reportTraceEvent(trace, "delivery.received", { elapsedMs: Date.now() - started, polls: attempt });
      return { text: result.text, model: result.model, usage: result.usage ?? undefined, toolCalls: result.toolCalls ?? undefined };
    }
    await pause(1000, options.signal);
  }
  throw new Error("Still waiting for the execution. Its result can be recovered from Trace Logs.");
}

function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); resolve(); };
    const stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); reject(new Error("cancelled")); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
}

export async function fetchTraceProgress(runId: string, after: number) {
  const res = await fetch(`/api/trace/runs/${encodeURIComponent(runId)}/progress?after=${after}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`could not load live trace (${res.status})`);
  return res.json() as Promise<{ cursor: number; events: (TraceEvent & { execId: string })[];
    steps: { execId: string; status: string; error: string | null; finishedMs: number | null }[] }>;
}
