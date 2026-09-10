import type { EmitEvent } from "./events.js";
import { event } from "./events.js";
/** Saved with a step, including failures before the runner returns a result. */
export type ContainerTrace = {
  image?: string;
  name?: string;
  exitCode?: number | null;
  signal?: string | null;
  oomKilled?: boolean;
  peakMemoryBytes?: number;
  termination?: string;
  dockerState?: unknown;
  events: { at: number; message: string }[];
  stderr: string;
  truncated: boolean;
};

const LOG_LIMIT = 64 * 1024;

export function containerLogger(secrets: string[], emit?: EmitEvent) {
  const trace: ContainerTrace = { events: [], stderr: "", truncated: false };
  let raw = "";
  const redact = (text: string) => secrets.filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((value, secret) => value.split(secret).join("[redacted]"), text);
  return {
    trace,
    event(message: string) {
      emit?.(event("proxy", "container.lifecycle", { message: redact(message).slice(0, 2000) }));
      if (trace.events.length < 100) trace.events.push({ at: Date.now(), message: redact(message).slice(0, 2000) });
    },
    stderr(chunk: string) {
      raw += chunk;
      if (raw.length > LOG_LIMIT) trace.truncated = true;
      raw = raw.slice(-LOG_LIMIT);
    },
    snapshot(): ContainerTrace {
      return { ...trace, events: [...trace.events], stderr: redact(raw) };
    },
  };
}
