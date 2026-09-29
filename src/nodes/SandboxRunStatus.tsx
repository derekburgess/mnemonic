import { useEffect, useRef, useState } from "react";
import { fetchTraceProgress } from "../api";
import type { InputData } from "../types";
import { applyExecutionProgress, initialExecutionStates, statusDuration, summarizeExecution, type NodeExecution } from "../executionStatus";

/** Its key changes for each run, so a late reply from the previous run cannot replace this one. */
export function SandboxRunStatus({ data }: { data: InputData }) {
  const execution = data.lastExecution;
  if (!execution?.execIds.length) return <StatusLine message={data.error ? `Failed: ${data.error}` : "Ready to run in a sandbox"} outcome={data.error ? "failed" : undefined} />;
  return <LiveStatus key={`${execution.runId}/${execution.execIds.join(",")}`} data={data} execution={execution} />;
}

function LiveStatus({ data, execution }: { data: InputData; execution: NodeExecution }) {
  const [states, setStates] = useState(() => initialExecutionStates(execution));
  const [unavailable, setUnavailable] = useState(false);
  const [now, setNow] = useState(Date.now);
  const latest = useRef(data);
  latest.current = data;
  const summary = summarizeExecution(states);
  const { runId, startedMs, timeoutSec } = execution;
  const execIds = execution.execIds.join(",");

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    let current = initialExecutionStates({ runId, execIds: execIds.split(","), startedMs, timeoutSec });
    const poll = async () => {
      let finished = false;
      try {
        const progress = await fetchTraceProgress(runId, cursor, controller.signal);
        if (controller.signal.aborted) return;
        cursor = progress.cursor;
        current = applyExecutionProgress(current, progress);
        // Admission failures and deleted traces have no server execution rows. Keep the
        // locally known outcome rather than leaving a finished node's clock running forever.
        if (latest.current.lastExecution?.finishedMs) {
          const status = latest.current.status;
          current = applyExecutionProgress(current, { cursor, events: [], steps: Object.keys(current).filter((id) => !progress.steps.some((s) => s.execId === id)).map((execId) => ({
            execId, status: status === "done" && !latest.current.error ? "ok" : status === "idle" ? "cancelled" : "error",
            error: latest.current.error ?? null, finishedMs: latest.current.lastExecution!.finishedMs!,
          })) });
        }
        finished = !summarizeExecution(current).active;
        setStates(current);
        setUnavailable(false);
      } catch {
        if (controller.signal.aborted) return;
        setUnavailable(true);
      }
      if (!finished) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [runId, execIds, startedMs, timeoutSec]);

  useEffect(() => {
    if (!summary.active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [summary.active]);

  const elapsed = statusDuration((summary.finishedMs ?? now) - summary.startedMs);
  return <StatusLine message={unavailable ? `Status unavailable — reconnecting (last: ${summary.message})` : summary.message}
    timing={`${elapsed} / ${statusDuration(summary.timeoutSec * 1000)}`} outcome={summary.outcome} />;
}

function StatusLine({ message, timing, outcome }: { message: string; timing?: string; outcome?: string }) {
  return <div className={`sandbox-row sandbox-status nodrag${outcome ? ` ${outcome}` : ""}`} title={message}>
    <span className="sandbox-status-message" role="status" aria-label="Sandbox status" aria-live="polite" aria-atomic="true">{message}</span>
    {timing && <span className="sandbox-status-time" aria-label="Elapsed time and timeout budget">{timing}</span>}
  </div>;
}
