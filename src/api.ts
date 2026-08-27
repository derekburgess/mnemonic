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

export async function runStep(args: {
  model: string;
  effort: Effort;
  input: string;
  instructions?: string;
  tools?: Record<string, unknown>[];
}): Promise<RunResponse> {
  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}
