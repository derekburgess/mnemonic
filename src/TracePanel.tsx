import { useCallback, useEffect, useState } from "react";
import {
  deleteTraceRun,
  fetchTraceRun,
  fetchTraceRuns,
  type TraceRun,
  type TraceStep,
} from "./api";
import { Icon } from "./icons";
import { CopyButton } from "./nodes/CopyButton";

const time = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "—");
const duration = (a: number | null, b: number | null) =>
  a && b ? `${((b - a) / 1000).toFixed(1)}s` : "—";

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

function StepDetail({ step }: { step: TraceStep }) {
  const thinking = (step.rounds ?? []).flatMap((round, i) =>
    ((round.response?.output as { type: string; summary?: { text?: string }[] }[]) ?? [])
      .filter((item) => item.type === "reasoning")
      .flatMap((item) => (item.summary ?? []).map((sum) => ({ round: i + 1, text: sum.text ?? "" })))
      .filter((entry) => entry.text),
  );

  return (
    <div className="trace-step-body">
      <dl className="trace-facts">
        <div><dt>Started</dt><dd>{time(step.startedMs)}</dd></div>
        <div><dt>Duration</dt><dd>{duration(step.startedMs, step.finishedMs)}</dd></div>
        <div><dt>Model asked</dt><dd>{step.requestedModel}</dd></div>
        <div><dt>Model served</dt><dd>{step.servedModel ?? "—"}</dd></div>
        <div><dt>Thinking</dt><dd>{step.effort}</dd></div>
        <div><dt>Tokens</dt><dd>{step.usage ? `${step.usage.input ?? "?"} in / ${step.usage.output ?? "?"} out` : "—"}</dd></div>
      </dl>

      {step.error && <Pre value={step.error} tone="error" />}

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

      <Section title="Input prompt (as sent)" open>
        <Pre value={step.inputPrompt} />
      </Section>

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
        <Pre value={step.outputText ?? "(none)"} />
      </Section>

      <Section title={`Raw rounds (${step.rounds?.length ?? 0})`}>
        <Pre value={step.rounds} />
      </Section>
    </div>
  );
}

function RunRow({ run, onDelete }: { run: TraceRun; onDelete: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<TraceStep[] | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);

  useEffect(() => {
    if (open && !steps) fetchTraceRun(run.runId).then(setSteps).catch(() => setSteps([]));
  }, [open, steps, run.runId]);

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
                {step.status === "error" && <span className="trace-errors">failed</span>}
              </button>
              {openStep === step.execId && <StepDetail step={step} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const WIDTH_KEY = "mnemonic.trace.width";
const MIN_WIDTH = 320;
/** Leave at least this much canvas visible however far the panel is dragged. */
const MIN_CANVAS = 280;

export function TracePanel({ onClose }: { onClose: () => void }) {
  const [runs, setRuns] = useState<TraceRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return saved >= MIN_WIDTH ? saved : 460;
  });

  /**
   * Dragged from the panel's left edge. A native `resize` grip would sit in the bottom-right
   * corner and grow the wrong way for a right-docked panel, so the edge is its own handle.
   */
  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = (e: PointerEvent) => {
      const next = Math.min(
        Math.max(window.innerWidth - e.clientX, MIN_WIDTH),
        Math.max(window.innerWidth - MIN_CANVAS, MIN_WIDTH),
      );
      setWidth(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("resizing-col");
      setWidth((w) => {
        try {
          localStorage.setItem(WIDTH_KEY, String(w));
        } catch {
          // Storage can be unavailable; the width just will not persist.
        }
        return w;
      });
    };
    document.body.classList.add("resizing-col");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }, []);

  const load = useCallback(() => {
    fetchTraceRuns()
      .then((r) => {
        setRuns(r);
        setError(null);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(load, [load]);

  const remove = useCallback(
    async (runId: string) => {
      await deleteTraceRun(runId).catch((err) => setError((err as Error).message));
      load();
    },
    [load],
  );

  return (
    <aside className="trace-panel" style={{ width }}>
      <div
        className="trace-grip"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize trace panel"
      />

      <header className="trace-head">
        <strong>Trace</strong>
        <div className="spacer" />
        <button onClick={load} title="Reload runs" aria-label="Reload runs">
          <Icon name="refresh" />
        </button>
        <button onClick={onClose} title="Close" aria-label="Close">
          <Icon name="close" />
        </button>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="trace-list">
        {!runs && !error && <p className="dim">Loading…</p>}
        {runs?.map((run) => (
          <RunRow key={run.runId} run={run} onDelete={remove} />
        ))}
      </div>
    </aside>
  );
}
