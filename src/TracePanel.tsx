import { ResizablePanel } from "./ResizablePanel";
import { deliveryState } from "../server/events";
import { useCallback, useEffect, useState } from "react";
import {
  deleteTraceRun,
  fetchTraceRun,
  fetchTraceProgress,
  fetchTraceRuns,
  type TraceRun,
  type TraceStep,
} from "./api";
import { Icon } from "./icons";
import { CopyButton } from "./nodes/CopyButton";

const time = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "—");
const duration = (a: number | null, b: number | null) =>
  a ? `${(((b ?? Date.now()) - a) / 1000).toFixed(1)}s` : "—";

/** A collapsible block of preformatted detail. */
function Section({ title, children, open }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="trace-section" open={open}>
      <summary>{title}</summary>
      <div className="trace-body">{children}</div>
    </details>
  );
}

/** Every block of detail is copyable; JSON is serialised the same way it is displayed. */
const Pre = ({ value, tone }: { value: unknown; tone?: "error" }) => {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="field trace-block">
      <pre className={`trace-pre${tone === "error" ? " trace-error" : ""}`}>{text}</pre>
      <CopyButton text={text} title="Copy" />
    </div>
  );
};

function StepDetail({ step, onRecover, outputExecIds }: { step: TraceStep; onRecover: (step: TraceStep) => Promise<void>; outputExecIds: string[] }) {
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("all");
  const timeline = (step.events ?? []).filter((e) => filter === "all" || e.kind.startsWith(filter + "."));
  const groups = new Map<string, typeof timeline>();
  for (const entry of timeline) {
    const detail = entry.detail as { round?: number; callId?: string; name?: string } | undefined;
    const key = /^(model|round)\./.test(entry.kind) ? `Model round ${detail?.round ?? "—"}`
      : entry.kind.startsWith("local.") ? "Local model lifecycle"
      : entry.kind.startsWith("tool.") && detail?.callId ? `Tool ${detail.name ?? "call"} · ${detail.callId}`
      : entry.kind.startsWith("delivery.") || entry.kind.startsWith("graph.") ? "Result delivery"
      : /^(container|runner|image)\./.test(entry.kind) ? "Container" : "Execution setup and outcome";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const toolEvents = (step.events ?? []).filter((e) => /tool\.(completed|failed)$/.test(e.kind));
  const thinking = (step.rounds ?? []).flatMap((round, i) =>
    ((round.response?.output as { type: string; summary?: { text?: string }[] }[]) ?? [])
      .filter((item) => item.type === "reasoning")
      .flatMap((item) => (item.summary ?? []).map((sum) => ({ round: i + 1, text: sum.text ?? "" })))
      .filter((entry) => entry.text),
  );

  return (
    <div className="trace-step-body">
      <dl className="trace-facts trace-overview">
        <div><dt>Execution</dt><dd>{step.status === "ok" ? "Completed" : step.status}</dd></div>
        <div><dt>Delivery</dt><dd>{outputExecIds.includes(step.execId) ? "Added to graph" : step.delivery}</dd></div>
        <div><dt>Duration</dt><dd>{duration(step.startedMs, step.finishedMs)}</dd></div>
        <div><dt>Last event</dt><dd>{(step.events ?? []).filter((e) => !/delivery\.poll|model\.http|container\.log/.test(e.kind)).at(-1)?.kind.replaceAll(".", " ").replaceAll("_", " ") ?? "No events"}</dd></div>
      </dl>
      <Section title="Execution details">
      <dl className="trace-facts">
        <div><dt>Execution</dt><dd>{step.status === "ok" ? "completed" : step.status}</dd></div>
        <div><dt>Delivery</dt><dd>{step.events?.length ? step.delivery : "not recorded"}</dd></div>
        <div><dt>Started</dt><dd>{time(step.startedMs)}</dd></div>
        <div><dt>Duration</dt><dd>{duration(step.startedMs, step.finishedMs)}</dd></div>
        <div><dt>Model asked</dt><dd>{step.requestedModel}</dd></div>
        <div><dt>Model served</dt><dd>{step.servedModel ?? "—"}</dd></div>
        <div><dt>Thinking</dt><dd>{step.effort}</dd></div>
        <div><dt>Tokens</dt><dd>{step.usage ? `${step.usage.input ?? "?"} in / ${step.usage.output ?? "?"} out` : "—"}</dd></div>
        <div><dt>Max rounds</dt><dd>{step.params?.maxRounds ?? "default"}</dd></div>
        <div><dt>Timeout</dt><dd>{step.params?.timeoutSec ? `${step.params.timeoutSec}s` : "default"}</dd></div>
      </dl>
      </Section>

      <Section title={`Timeline (${step.events?.length ?? 0})`} open>
        <label className="trace-filter"><span>Filter by</span><select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {["all", "model", "local", "tool", "container", "delivery", "graph"].map((name) => <option key={name}>{name}</option>)}
        </select></label>
        {timeline.length === 0 && <p className="dim">No events recorded.</p>}
        {[...groups].map(([label, entries]) => <details key={label} className="trace-section"><summary className="trace-group-summary"><span className="trace-group-label">{label}</span><span className="trace-group-count">· {entries.length} events</span></summary>
        {entries.map((entry) => <details key={entry.id} className="trace-section">
          <summary title={`Received by proxy: ${time(entry.receivedMs ?? null)}`}>
            <span className="dim">{((entry.at - step.startedMs) / 1000).toFixed(2)}s · {entry.source}</span>{" "}
            {entry.kind.replaceAll(".", " ").replaceAll("_", " ")}
          </summary>
          <Pre value={entry.detail ?? "(no additional details)"} />
        </details>)}
        </details>)}
      </Section>
      {!!toolEvents.length && <Section title={`Tool timings (${toolEvents.length})`}>
        <table><thead><tr><th>Tool</th><th>Round</th><th>Duration</th><th>Outcome</th></tr></thead>
          <tbody>{toolEvents.map((entry) => {
            const d = entry.detail as { name?: string; round?: number; ms?: number; status?: string };
            return <tr key={entry.id}><td>{d?.name ?? "—"}</td><td>{d?.round ?? "—"}</td>
              <td>{d?.ms === undefined ? "—" : `${(d.ms / 1000).toFixed(2)}s`}</td><td>{d?.status ?? "error"}</td></tr>;
          })}</tbody></table>
      </Section>}
      <Section title="Correlation and deadlines">
        <Pre value={{ runId: step.runId, execId: step.execId, nodeId: step.nodeId, executionTimeoutSec: step.params?.timeoutSec ?? 300,
          deliveryTimeoutSec: step.params?.deliveryTimeoutSec }} />
      </Section>

      {step.error && <Pre value={step.error} tone="error" />}

      {step.params?.sandboxConfig && <Section title="Sandbox configuration"><Pre value={step.params.sandboxConfig} /></Section>}

      {step.container && (
        <Section title="Container diagnostics" open={step.status === "error"}>
          <Pre value={{ image: step.container.image, name: step.container.name,
            exitCode: step.container.exitCode, signal: step.container.signal, oomKilled: step.container.oomKilled,
            peakMemoryBytes: step.container.peakMemoryBytes, termination: step.container.termination, dockerState: step.container.dockerState }} />
          <Pre value={step.container.events.map((e) => `${time(e.at)}  ${e.message}`).join("\n")} />
          {step.container.truncated && <p className="dim">Earlier logs omitted; showing the last 65,536 characters.</p>}
          <Pre value={step.container.stderr || "(no stderr logged)"} />
        </Section>
      )}

      <Section title="System prompt">
        <Pre value={step.systemPrompt ?? "(none sent)"} />
      </Section>

      <Section title={`Context in (${step.context?.length ?? 0})`}>
        {step.context?.length ? (
          step.context.map((c, i) => (
            <div key={i}>
              <span className="dim">from {c.label}</span>
              <Pre value={c.text} />
            </div>
          ))
        ) : (
          <p className="dim">No upstream context was wired in.</p>
        )}
      </Section>

      <Section title="Input prompt (as sent)">
        <Pre value={step.inputPrompt} />
      </Section>

      {!!step.files?.length && (
        <Section title={`Files attached (${step.files.length})`}>
          <Pre
            value={step.files
              .map((f) => `${f.name}  ${f.mime}  ${(f.bytes / 1024).toFixed(1)} KB`)
              .join("\n")}
          />
        </Section>
      )}

      {!!step.links?.length && (
        <Section title={`Links (${step.links.length})`}>
          <Pre
            value={step.links
              .map((l) => `${l.kind.padEnd(7)} ${l.url}${l.note ? `  — ${l.note}` : ""}`)
              .join("\n")}
          />
        </Section>
      )}

      <Section title={`Tools offered (${step.tools?.length ?? 0})`}>
        {step.tools?.length ? <Pre value={step.tools} /> : <p className="dim">None.</p>}
      </Section>

      <Section title={`Tool calls (${step.toolCalls?.length ?? 0})`}>
        {step.toolCalls?.length ? <Pre value={step.toolCalls} /> : <p className="dim">None.</p>}
      </Section>

      {thinking.length > 0 && (
        <Section title={`Thinking (${thinking.length})`}>
          {thinking.map((t, i) => (
            <div key={i}>
              <span className="dim">round {t.round}</span>
              <Pre value={t.text} />
            </div>
          ))}
        </Section>
      )}

      <Section title="Output" open>
        {step.status === "ok" && <button disabled={adding || outputExecIds.includes(step.execId)} onClick={async () => {
          setAdding(true); setRecoverError(null);
          try { await onRecover(step); } catch (err) { setRecoverError((err as Error).message); } finally { setAdding(false); }
        }}>{outputExecIds.includes(step.execId) ? "Already on graph" : adding ? "Adding…" : "Add saved output to graph"}</button>}
        {recoverError && <p className="error">{recoverError}</p>}
        <Pre value={step.outputText ?? "(none)"} />
      </Section>

      <Section title={`Raw rounds (${step.rounds?.length ?? 0})`}>
        <Pre value={step.rounds} />
      </Section>
    </div>
  );
}

function RunRow({ run, onDelete, onRecover, outputExecIds }: { run: TraceRun; onDelete: (id: string) => void; onRecover: (step: TraceStep) => Promise<void>; outputExecIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<TraceStep[] | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let cursor = 0;
    let current: TraceStep[] = [];
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        if (!current.length) current = await fetchTraceRun(run.runId);
        const progress = await fetchTraceProgress(run.runId, cursor);
        if (progress.steps.some((s) => !current.some((old) => old.execId === s.execId) ||
          current.some((old) => old.execId === s.execId && old.status !== s.status))) {
          current = await fetchTraceRun(run.runId);
        }
        current = current.map((step) => {
          const events = [...new Map([...(step.events ?? []), ...progress.events.filter((e) => e.execId === step.execId)]
            .map((e) => [e.id, e])).values()].sort((a, b) => a.at - b.at || (a.order ?? 0) - (b.order ?? 0));
          return { ...step, events, delivery: deliveryState(events) };
        });
        cursor = progress.cursor;
        if (!stopped) { setSteps(current); setLiveError(null); }
      } catch (err) {
        if (!stopped) setLiveError((err as Error).message);
      } finally {
        if (!stopped) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [open, run.runId]);

  return (
    <div className="trace-run">
      <header className="trace-run-head">
        <button className="trace-toggle" onClick={() => setOpen((v) => !v)}>
          <span className={`caret${open ? " open" : ""}`}>›</span>
          <span className="trace-when">{time(run.startedMs)}</span>
          <span className="badge-kind">{run.kind}</span>
          <span className="dim">
            {run.steps} step{run.steps === 1 ? "" : "s"} · {duration(run.startedMs, run.finishedMs)}
            {run.models ? ` · ${run.models}` : ""}
          </span>
          {!!run.running && <span className="dim">{run.running} running</span>}
          {run.errors > 0 && <span className="trace-errors">{run.errors} failed</span>}
        </button>
        <button
          className="tinted tint-err"
          onClick={() => onDelete(run.runId)}
          title="Delete this run"
          aria-label="Delete this run"
        >
          <Icon name="trash" />
        </button>
      </header>

      {open && (
        <div className="trace-steps">
          {liveError && <p className="error">Live updates paused: {liveError}. Retrying…</p>}
          {!steps && <p className="dim">Loading…</p>}
          {steps?.length === 0 && <p className="dim">No steps recorded.</p>}
          {steps?.map((step) => (
            <div className="trace-step" key={step.execId}>
              <button
                className="trace-toggle"
                onClick={() => setOpenStep((v) => (v === step.execId ? null : step.execId))}
              >
                <span className={`caret${openStep === step.execId ? " open" : ""}`}>›</span>
                <span className="place">{(step.seq ?? 0) + 1}</span>
                <strong>{step.label || step.nodeId}</strong>
                <span className="dim">
                  {step.requestedModel} · {step.effort} ·{" "}
                  {duration(step.startedMs, step.finishedMs)}
                </span>
                {<span className={step.status === "error" || step.status === "interrupted" ? "trace-errors" : "dim"}>{step.status === "ok" ? "completed" : step.status} · {step.events?.length ? step.delivery : "delivery not recorded"}</span>}
              </button>
              {openStep === step.execId && <StepDetail step={step} onRecover={onRecover} outputExecIds={outputExecIds} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TracePanel({ onClose, onRecover, outputExecIds }: { onClose: () => void; onRecover: (step: TraceStep) => Promise<void>; outputExecIds: string[] }) {
  const [runs, setRuns] = useState<TraceRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchTraceRuns()
      .then((r) => {
        setRuns(r);
        setError(null);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => { load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, [load]);

  const remove = useCallback(
    async (runId: string) => {
      await deleteTraceRun(runId).catch((err) => setError((err as Error).message));
      load();
    },
    [load],
  );

  return (
    <ResizablePanel className="trace-panel" storageKey="mnemonic.trace.width" defaultWidth={460}
      label="Trace Logs" resizeLabel="Resize trace panel">
      <header className="trace-head">
        <strong>Trace Logs</strong>
        <div className="spacer" />
        <button
          className="tinted tint-warn"
          onClick={load}
          title="Refresh trace logs"
          aria-label="Refresh trace logs"
        >
          <Icon name="refresh" />
        </button>
        <button className="tinted tint-err" onClick={onClose} title="Close" aria-label="Close">
          <Icon name="close" />
        </button>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="trace-list">
        {!runs && !error && <p className="dim">Loading…</p>}
        {runs?.map((run) => (
          <RunRow key={run.runId} run={run} onDelete={remove} onRecover={onRecover} outputExecIds={outputExecIds} />
        ))}
      </div>
    </ResizablePanel>
  );
}
