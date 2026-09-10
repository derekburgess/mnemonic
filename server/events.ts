export type TraceEvent = {
  id: string;
  at: number;
  source: "browser" | "proxy" | "container";
  kind: string;
  detail?: unknown;
  receivedMs?: number;
  order?: number;
};
export type EmitEvent = (event: TraceEvent) => void;
export const event = (source: TraceEvent["source"], kind: string, detail?: unknown): TraceEvent =>
  ({ id: crypto.randomUUID(), at: Date.now(), source, kind, detail });

export const redactText = (s: string, secrets: string[] = []) => secrets.filter(Boolean).sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join("[redacted]"), s)
    .replace(/([?&](?:api_key|token|key|access_token)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]");

/** Redact before persistence, then bound depth, collections and the whole payload. */
export function sanitize(value: unknown, secrets: string[] = [], limit = 16_384): unknown {
  const cleanText = (s: string) => redactText(s, secrets);
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 12) return "[depth limit]";
    if (typeof v === "string") { const text = cleanText(v); return text.length > limit ? text.slice(0, limit - 20) + "…[truncated]" : text; }
    if (typeof v === "bigint") return String(v);
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 200).map(([k, x]) =>
      [k, /authorization|api.?key|password|secret|token|cookie/i.test(k) && !/tokens|token_usage/i.test(k)
        ? "[redacted]" : walk(x, depth + 1)]));
    return v;
  };
  const safe = walk(value, 0);
  if (typeof safe === "string") return safe;
  const text = JSON.stringify(safe);
  if (text && text.length > limit) {
    const metadata = safe && typeof safe === "object" ? Object.fromEntries(Object.entries(safe)
      .filter(([, v]) => typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length < 256))
      .slice(0, 16)) : {};
    return { ...metadata, truncated: true, preview: text.slice(0, Math.max(0, limit - JSON.stringify(metadata).length - 100)) };
  }
  return safe;
}

export function deliveryState(events: TraceEvent[]): string {
  // A delayed/retried event must never undo a graph acknowledgement.
  if (events.some((e) => e.kind === "graph.committed")) return "added to graph";
  const last = [...events].reverse().find((e) => ["graph.failed", "delivery.cancelled", "delivery.failed",
    "delivery.recovered", "delivery.received", "delivery.recovering"].includes(e.kind));
  return ({ "graph.failed": "graph commit failed", "delivery.cancelled": "cancelled",
    "delivery.failed": "delivery failed", "delivery.recovered": "recovered from trace",
    "delivery.received": "received", "delivery.recovering": "recovering" } as Record<string, string>)[last?.kind ?? ""] ?? "awaiting delivery";
}

/** Observes SDK HTTP attempts, including its internal retries, without logging headers/bodies. */
export function tracedFetch(emit: EmitEvent, source: TraceEvent["source"]): typeof fetch {
  return async (input, init) => {
    const started = Date.now();
    const headers = new Headers(init?.headers);
    const retry = Number(headers.get("x-stainless-retry-count") ?? 0);
    emit(event(source, "model.http_attempt", { retry }));
    try {
      const response = await fetch(input, init);
      emit(event(source, "model.http_response", { retry, status: response.status,
        requestId: response.headers.get("x-request-id"), retryAfter: response.headers.get("retry-after"), ms: Date.now() - started }));
      return response;
    } catch (err) {
      emit(event(source, "model.http_error", { retry, ms: Date.now() - started, error: errorDetail(err) }));
      throw err;
    }
  };
}

export function errorDetail(err: unknown) {
  const e = err as { name?: string; message?: string; code?: unknown; status?: number };
  return { name: e?.name, message: e?.message ?? String(err), code: e?.code, status: e?.status,
    timeout: /timeout|timed out|exceeded|abort/i.test(`${e?.name} ${e?.message}`) };
}
