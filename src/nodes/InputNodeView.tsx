import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Effort, InputNode } from "../types";
import { CopyButton } from "./CopyButton";
import { DeleteButton } from "./DeleteButton";
import { SkipToggle } from "./SkipToggle";
import { useGraphActions } from "./context";

const EFFORTS: Effort[] = ["off", "minimal", "low", "medium", "high"];
const MAX_OUTPUTS = 8;

export function InputNodeView({ id, data }: NodeProps<InputNode>) {
  const { models, currentId, updateInput: onChange, runOne: onRun, removeNode: onDelete, setSkipped } =
    useGraphActions();
  const busy = data.status === "running";
  const skipped = !!data.skipped;
  const current = currentId === id;

  return (
    <div className={`node input${current ? " current" : ""} status-${data.status}${skipped ? " skipped" : ""}`}>
      <Handle type="target" position={Position.Top} />

      <header className="node-head">
        <input
          className="label nodrag"
          value={data.label}
          onChange={(e) => onChange(id, { label: e.target.value })}
          aria-label="Step name"
        />
        <SkipToggle on={skipped} onChange={(v) => setSkipped(id, v)} title="Skip this step when running" />
        <DeleteButton onClick={() => onDelete(id)} title="Delete step" />
      </header>

      <div className="row">
        <label>
          Model
          <select
            className="nodrag"
            value={data.model}
            onChange={(e) => onChange(id, { model: e.target.value })}
          >
            {(models.includes(data.model) ? models : [data.model, ...models]).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="row">
        <label>
          Thinking
          <select
            className="nodrag"
            value={data.effort}
            onChange={(e) => onChange(id, { effort: e.target.value as Effort })}
          >
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        <label>
          Output N
          <select
            className="nodrag"
            value={data.outputs}
            onChange={(e) => onChange(id, { outputs: Number(e.target.value) })}
          >
            {Array.from({ length: MAX_OUTPUTS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="stack">
        Role
        <input
          className="line nodrag"
          value={data.role ?? ""}
          onChange={(e) => onChange(id, { role: e.target.value })}
        />
      </label>

      <label className="stack">
        Instructions (System Prompt + Role)
        <div className="field">
          <textarea
            className="instructions nodrag nowheel"
            value={data.instructions ?? ""}
            onChange={(e) => onChange(id, { instructions: e.target.value })}
          />
          <CopyButton text={data.instructions ?? ""} title="Copy instructions" />
        </div>
      </label>

      <label className="stack">
        Input
        <div className="field">
          <textarea
            className="prompt nodrag nowheel"
            value={data.prompt}
            onChange={(e) => onChange(id, { prompt: e.target.value })}
          />
          <CopyButton text={data.prompt} title="Copy input" />
        </div>
      </label>

      {data.error && <p className="error">{data.error}</p>}

      <button className="run tinted tint-ok nodrag" onClick={() => onRun(id)} disabled={busy || skipped}>
        {busy ? <span className="spinner" role="status" aria-label="Running" /> : "Run"}
      </button>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
