import { event, sanitize, type TraceEvent } from "../server/events";

export type TraceIdentity = { runId: string; execId: string };
type Batch = TraceIdentity & { events: TraceEvent[]; attempts: number };
const pending = new Map<string, Batch>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Telemetry never blocks result delivery. Stable event IDs make retries idempotent. */
export function reportTraceEvent(trace: TraceIdentity | undefined, kind: string, detail?: unknown) {
  if (!trace) return;
  const key = `${trace.runId}/${trace.execId}`;
  const batch = pending.get(key) ?? { ...trace, events: [], attempts: 0 };
  if (batch.events.length < 100) batch.events.push(event("browser", kind, sanitize(detail)));
  pending.set(key, batch);
  timer ??= setTimeout(() => { timer = undefined; void flushTraceEvents(); }, 250);
}

export async function flushTraceEvents() {
  const batches = [...pending.entries()];
  pending.clear();
  await Promise.all(batches.map(async ([key, batch]) => {
    try {
      const res = await fetch("/api/trace/events", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch), signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`trace write ${res.status}`);
    } catch {
      if (++batch.attempts < 3) {
        const newer = pending.get(key);
        pending.set(key, { ...batch, events: [...batch.events, ...(newer?.events ?? [])].slice(-100) });
        timer ??= setTimeout(() => { timer = undefined; void flushTraceEvents(); }, 3000);
      }
    }
  }));
}
