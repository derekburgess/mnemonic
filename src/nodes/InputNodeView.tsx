import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Effort, InputNode, ToolConfig } from "../types";
import { Icon } from "../icons";
import { uid } from "../graph";
import { CopyButton } from "./CopyButton";
import { DeleteButton } from "./DeleteButton";
import { SkipToggle } from "./SkipToggle";
import { ToolEditor } from "./ToolEditor";
import { useGraphActions } from "./context";
import { useFieldWidth } from "./useFieldWidth";

const EFFORTS: Effort[] = ["off", "minimal", "low", "medium", "high"];
const MAX_OUTPUTS = 8;

export function InputNodeView({ id, data }: NodeProps<InputNode>) {
  const { models, currentId, runOrder, updateInput: onChange, runOne: onRun, removeNode: onDelete, setSkipped } =
    useGraphActions();
  const place = runOrder.indexOf(id);
  const busy = data.status === "running";
  const skipped = !!data.skipped;
  const current = currentId === id;
  const { field } = useFieldWidth();

  const tools = data.tools ?? [];
  const setTools = (next: ToolConfig[]) => onChange(id, { tools: next });
  const patchTool = (toolId: string, patch: Partial<ToolConfig>) =>
    setTools(tools.map((t) => (t.id === toolId ? { ...t, ...patch } : t)));

  return (
    <div className={`node input${current ? " current" : ""} status-${data.status}${skipped ? " skipped" : ""}`}>
      <Handle type="target" position={Position.Left} />

      <header className="node-head">
        <span className="place" title={place < 0 ? "Not scheduled" : `Runs ${place + 1} of ${runOrder.length}`}>
          {place < 0 ? "–" : place + 1}
        </span>
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
            {...field()}
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
            {...field()}
            className="prompt nodrag nowheel"
            value={data.prompt}
            onChange={(e) => onChange(id, { prompt: e.target.value })}
          />
          <CopyButton text={data.prompt} title="Copy input" />
        </div>
      </label>

      <div className="tools">
        <div className="tools-head">
          <span>Tools ({tools.length})</span>
          <button
            className="nodrag add-tool"
            title="Add a tool"
            aria-label="Add a tool"
            onClick={() =>
              setTools([
                ...tools,
                {
                  id: uid(),
                  label: `Tool ${tools.length + 1}`,
                  kind: "web_search",
                  contextSize: "medium",
                },
              ])
            }
          >
            <Icon name="plus" />
          </button>
        </div>

        {tools.map((tool) => (
          <ToolEditor
            key={tool.id}
            tool={tool}
            onChange={(patch) => patchTool(tool.id, patch)}
            onRemove={() => setTools(tools.filter((t) => t.id !== tool.id))}
          />
        ))}
      </div>

      {data.error && <p className="error nodrag">{data.error}</p>}

      <button className="run tinted tint-ok nodrag" onClick={() => onRun(id)} disabled={busy || skipped}>
        {busy ? (
          <span className="spinner" role="status" aria-label="Running" />
        ) : (
          <>
            <Icon name="play" /> Run
          </>
        )}
      </button>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
