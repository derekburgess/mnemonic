import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Attachment, Effort, InputFile, InputNode, ToolConfig } from "../types";
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
const ROUND_CHOICES = [1, 2, 4, 6, 8, 12, 16, 20, 30, 50];
const DEFAULT_ROUNDS = 12;
/** Seconds, rendered compactly once past a minute. */
const TIMEOUT_CHOICES = [30, 60, 120, 300, 600, 900, 1800, 3600];
const DEFAULT_TIMEOUT_SEC = 300;
const asDuration = (sec: number) => (sec < 60 ? `${sec}s` : `${sec / 60}m`);

export function InputNodeView({ id, data }: NodeProps<InputNode>) {
  const { models, currentId, runOrder, updateInput: onChange, runOne: onRun, removeNode: onDelete, setSkipped } =
    useGraphActions();
  const place = runOrder.indexOf(id);
  const busy = data.status === "running";
  const skipped = !!data.skipped;
  const current = currentId === id;
  const { field } = useFieldWidth();

  const attachments = data.attachments ?? [];
  const attach = async (files: FileList) => {
    const read = await Promise.all(
      [...files].map(async (file) => ({ id: uid(), name: file.name, text: await file.text() })),
    );
    onChange(id, { attachments: [...attachments, ...read] as Attachment[] });
  };

  const files = data.files ?? [];
  const attachFiles = async (picked: FileList) => {
    const read = await Promise.all(
      [...picked].map(
        (file) =>
          new Promise<InputFile>((resolve, reject) => {
            // A data URL keeps the bytes intact for PDFs and images alike.
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                id: uid(),
                name: file.name,
                mime: file.type || "application/octet-stream",
                dataUrl: String(reader.result),
              });
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          }),
      ),
    );
    onChange(id, { files: [...files, ...read] });
  };

  const links = data.links ?? [];

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

      <div className="row">
        <label title="How many times the model may come back asking for more tools. One turn may contain several calls.">
          Max Tool Turns
          <select
            className="nodrag"
            value={data.maxRounds ?? DEFAULT_ROUNDS}
            onChange={(e) => onChange(id, { maxRounds: Number(e.target.value) })}
          >
            {ROUND_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label title="Budget for the whole step: every round plus the tools they call">
          Timeout
          <select
            className="nodrag"
            value={data.timeoutSec ?? DEFAULT_TIMEOUT_SEC}
            onChange={(e) => onChange(id, { timeoutSec: Number(e.target.value) })}
          >
            {TIMEOUT_CHOICES.map((n) => (
              <option key={n} value={n}>
                {asDuration(n)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="stack">
        <label className="file nodrag attach">
          <Icon name="upload" /> Attach skill files (.md)
          <input
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            multiple
            onChange={(e) => {
              if (e.target.files?.length) void attach(e.target.files);
              e.target.value = "";
            }}
          />
        </label>

        {attachments.map((file) => (
          <div className="attachment" key={file.id} title={`${file.name} — ${file.text.length} characters`}>
            <span className="attachment-name">{file.name}</span>
            <button
              className="icon tinted tint-err nodrag"
              onClick={() =>
                onChange(id, { attachments: attachments.filter((a) => a.id !== file.id) })
              }
              title={`Remove ${file.name}`}
              aria-label={`Remove ${file.name}`}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
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

      <div className="stack">
        <label className="file nodrag attach">
          <Icon name="upload" /> Attach files (.pdf, .txt, .png, .jpg)
          <input
            type="file"
            accept=".pdf,.txt,.png,.jpg,.jpeg,application/pdf,text/plain,image/png,image/jpeg"
            multiple
            onChange={(e) => {
              if (e.target.files?.length) void attachFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>

        {files.map((file) => (
          <div className="attachment" key={file.id} title={`${file.name} — ${file.mime}`}>
            <span className="attachment-name">{file.name}</span>
            <button
              className="icon tinted tint-err nodrag"
              onClick={() => onChange(id, { files: files.filter((f) => f.id !== file.id) })}
              title={`Remove ${file.name}`}
              aria-label={`Remove ${file.name}`}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
      </div>

      <div className="stack">
        <button
          className="file nodrag attach"
          onClick={() => onChange(id, { links: [...links, { id: uid(), url: "" }] })}
        >
          <Icon name="plus" /> Add links
        </button>

        {links.map((link) => (
          <div className="attachment" key={link.id}>
            <input
              className="line nodrag"
              placeholder="https://…"
              value={link.url}
              aria-label="Link URL"
              onChange={(e) =>
                onChange(id, {
                  links: links.map((l) => (l.id === link.id ? { ...l, url: e.target.value } : l)),
                })
              }
            />
            <button
              className="icon tinted tint-err nodrag"
              onClick={() => onChange(id, { links: links.filter((l) => l.id !== link.id) })}
              title="Remove link"
              aria-label="Remove link"
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
      </div>

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
            <Icon name="play" /> Run step
          </>
        )}
      </button>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
