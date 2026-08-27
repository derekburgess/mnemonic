import type { Effort } from "./types";

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
};

export async function runStep(args: {
  model: string;
  effort: Effort;
  input: string;
  instructions?: string;
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
