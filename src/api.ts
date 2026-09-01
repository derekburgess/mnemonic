import type { Effort, ToolCallRecord, ToolConfig } from "./types";

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
  runId: string;
  execId: string;
  kind: "run" | "next" | "step";
  seq: number;
  nodeId: string;
  label: string;
  context: { label: string; text: string }[];
};

export type TraceRun = {
  runId: string;
  kind: string;
  startedMs: number;
  finishedMs: number;
  steps: number;
  errors: number;
  models: string;
};

export type TraceStep = {
  execId: string;
  seq: number;
  nodeId: string;
  label: string;
  requestedModel: string;
  servedModel: string | null;
  effort: string;
  startedMs: number;
  finishedMs: number;
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
};

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
    trace?: TraceMeta;
  },
  signal?: AbortSignal,
): Promise<RunResponse> {
  // Without a deadline a hung request would leave the UI stuck in its running state forever.
  const budgetSec = args.timeoutSec ?? DEFAULT_STEP_TIMEOUT_SEC;
  const timeout = AbortSignal.timeout(budgetSec * 1000);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: merged,
    });
  } catch (err) {
    if (signal?.aborted) throw new Error("cancelled");
    if ((err as Error).name === "TimeoutError") {
      throw new Error(
        `The step hit its ${budgetSec}s timeout. Raise "Timeout" if it legitimately takes longer.`,
      );
    }
    throw err;
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}
