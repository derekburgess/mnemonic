import type { Effort, ToolCallRecord, ToolNode } from "./types";

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

/** Flatten a tool node into the shape the proxy expects. */
export function toolSpec(node: ToolNode): Record<string, unknown> {
  const d = node.data;
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
    };
  }
  return {
    kind: "custom",
    fnName: d.fnName || "custom_tool",
    fnDescription: d.fnDescription,
    fnParameters: d.fnParameters,
    fnCode: d.fnCode,
  };
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

/** A reasoning model with tools can legitimately take minutes; past this it is hung. */
const RUN_TIMEOUT_MS = 300_000;

export async function runStep(
  args: {
    model: string;
    effort: Effort;
    input: string;
    instructions?: string;
    tools?: Record<string, unknown>[];
    trace?: TraceMeta;
  },
  signal?: AbortSignal,
): Promise<RunResponse> {
  // Without a deadline a hung request would leave the UI stuck in its running state forever.
  const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
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
      throw new Error(`no response after ${RUN_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}
