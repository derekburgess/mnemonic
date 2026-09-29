import type { TraceEvent } from "../server/events";

export type NodeExecution = {
  runId: string;
  execIds: string[];
  startedMs: number;
  timeoutSec: number;
  finishedMs?: number;
};
export type ExecutionProgress = {
  cursor: number;
  events: (TraceEvent & { execId: string })[];
  steps: { execId: string; status: string; error: string | null; finishedMs: number | null }[];
};
type Phase = "waiting" | "preparing" | "working" | "stopping" | "cleanup";
export type ExecutionState = {
  message: string;
  phase: Phase;
  round?: number;
  startedMs: number;
  timeoutSec: number;
  finishedMs?: number;
  outcome?: "completed" | "failed" | "cancelled";
};
export type ExecutionStates = Record<string, ExecutionState>;
export const initialExecutionStates = (execution: NodeExecution): ExecutionStates => Object.fromEntries(
  execution.execIds.map((id) => [id, { message: "Starting execution", phase: "waiting",
    startedMs: execution.startedMs, timeoutSec: execution.timeoutSec }]),
);
const shortError = (error: unknown): string => {
  const message = typeof error === "string" ? error : (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message.split("\n")[0].slice(0, 180) : "Execution failed";
};
const isTimeout = (message: string) => /timeout|timed out|deadline exceeded/i.test(message);

/** Ignore raw logs, HTTP attempts and delivery polls: they must not replace the work phase. */
function applyEvent(state: ExecutionState, entry: TraceEvent): ExecutionState {
  if (state.outcome) return state;
  const detail = (entry.detail ?? {}) as Record<string, unknown>;
  const set = (message: string, phase: Phase = "preparing") => ({ ...state, message, phase });
  const generating = () => set(`Generating response${state.round ? ` · round ${state.round}` : ""}`, "working");
  switch (entry.kind) {
    case "execution.budget": {
      const timeoutSec = typeof detail.timeoutSec === "number" ? detail.timeoutSec : state.timeoutSec;
      return { ...state, timeoutSec, startedMs: typeof detail.deadlineMs === "number"
        ? detail.deadlineMs - timeoutSec * 1000 : state.startedMs };
    }
    case "request.accepted": return set("Preparing execution");
    case "local.queued": return set("Queued — waiting for the local model worker", "waiting");
    case "local.preparing": return set("Preparing model container");
    case "local.building runtime":
    case "local.image_build_started": return set("Building model image");
    case "local.starting container":
    case "local.container_created": return set("Starting model container");
    case "local.loading": return set("Loading model");
    case "local.ready": return set("Model ready");
    case "image.build_started": return set("Building sandbox image");
    case "image.waiting": return set("Waiting for sandbox image");
    case "image.cached":
    case "image.build_ready": return set("Sandbox image ready");
    case "container.starting": return set("Starting execution container");
    case "runner.accepted":
    case "tools.preparing":
    case "tool.connection_attempt": return state.phase === "working" ? state : set("Connecting tools");
    case "model.started": {
      const round = typeof detail.round === "number" ? detail.round : undefined;
      return { ...set(`Generating response${round ? ` · round ${round}` : ""}`, "working"), round };
    }
    case "local.running": return generating();
    case "tool.started": return set(`Running tool: ${typeof detail.name === "string" ? detail.name : "tool"}`, "working");
    case "runner.completed":
    case "container.exited":
    case "container.cleanup":
    case "local.unloading":
    case "local.unloaded": return set("Cleaning up containers", "cleanup");
    case "delivery.cancelled": return set("Stopping — cancelled", "stopping");
    case "runner.failed":
    case "execution.failed":
    case "local.error": {
      const error = shortError(detail.error ?? detail.message);
      return set(isTimeout(error) ? "Stopping — timeout reached" : /cancelled/i.test(error)
        ? "Stopping — cancelled" : `Stopping — ${error}`, "stopping");
    }
    case "container.lifecycle": {
      const message = typeof detail.message === "string" ? detail.message : "";
      if (/Checking Docker/.test(message)) return set("Checking Docker");
      if (/Preparing sandbox image/.test(message)) return set("Preparing sandbox image");
      if (/Starting container/.test(message)) return set("Starting execution container");
      if (/forcing container termination/.test(message)) return set(isTimeout(message)
        ? "Stopping — timeout reached" : "Stopping — cancelled", "stopping");
      if (/Container process closed|cleanup attempted/.test(message)) return set("Cleaning up containers", "cleanup");
      return state;
    }
    default: return state;
  }
}

export function applyExecutionProgress(states: ExecutionStates, progress: ExecutionProgress): ExecutionStates {
  const next = { ...states };
  for (const entry of [...progress.events].sort((a, b) => (a.order ?? a.at) - (b.order ?? b.at))) {
    if (Object.hasOwn(next, entry.execId)) next[entry.execId] = applyEvent(next[entry.execId], entry);
  }
  // Terminal rows are saved after cleanup. A completed model response alone is not completion.
  for (const step of progress.steps) {
    if (!Object.hasOwn(next, step.execId) || !["ok", "error", "cancelled"].includes(step.status)) continue;
    const cancelled = step.status === "cancelled" || step.error === "cancelled";
    next[step.execId] = { ...next[step.execId], finishedMs: step.finishedMs ?? Date.now(),
      outcome: cancelled ? "cancelled" : step.status === "ok" ? "completed" : "failed",
      message: cancelled ? "Cancelled" : step.status === "ok" ? "Completed"
        : `Failed: ${isTimeout(step.error ?? "") ? "timeout reached" : shortError(step.error)}` };
  }
  return next;
}

export function summarizeExecution(states: ExecutionStates) {
  const all = Object.values(states);
  const active = all.filter((state) => !state.outcome);
  const priority: Record<Phase, number> = { waiting: 0, preparing: 1, cleanup: 2, working: 3, stopping: 4 };
  const selected = active.sort((a, b) => priority[b.phase] - priority[a.phase])[0]
    ?? all.find((s) => s.outcome === "failed") ?? all.find((s) => s.outcome === "cancelled") ?? all[0];
  const completed = all.length - active.length;
  return { ...selected, active: active.length > 0,
    message: selected.message + (all.length > 1 ? ` · ${completed}/${all.length} finished` : ""),
    finishedMs: active.length ? undefined : Math.max(...all.map((s) => s.finishedMs ?? s.startedMs)) };
}

export function statusDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
}
