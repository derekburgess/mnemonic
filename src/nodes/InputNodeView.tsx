import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Attachment, Effort, InputFile, InputNode, ToolConfig, Workspace } from "../types";
import { Icon } from "../icons";
import { pickFolderNatively, resolveFolder, type Provider } from "../api";
import { pickDirectory } from "../pickDirectory";
import { uid } from "../graph";
import { SandboxRunStatus } from "./SandboxRunStatus";
import { SandboxToggle } from "./SandboxToggle";
import { WorkspaceRow } from "./WorkspaceRow";
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
  const { providerModels, providerSettings, defaultProvider, currentId, updateInput: onChange, runOne: onRun, removeNode: onDelete, setSkipped } =
    useGraphActions();
  const provider = data.provider ?? defaultProvider;
  const models = providerModels[provider] ?? [];
  const localModelsRequired = provider === "huggingface" && !!providerSettings?.providers?.find((p) => p.provider === provider)?.runLocally;
  const providers = providerSettings?.providers?.filter((p) => p.configured) ?? [];
  const providerNames = { openai: "OpenAI", compatible: "OpenAI-compatible", huggingface: "Hugging Face" };
  const busy = data.status === "running";
  const skipped = !!data.skipped;
  const current = currentId === id;
  const { field } = useFieldWidth();
  /** Rows waiting on the proxy to locate the folder the dialog just returned. */
  const [locating, setLocating] = useState<string[]>([]);
  /** Rows whose lookup was not conclusive, keyed by row id. */
  const [notes, setNotes] = useState<Record<string, string>>({});

  const workspaces = data.workspaces ?? [];
  const setWorkspaces = (next: Workspace[]) => onChange(id, { workspaces: next });
  // Resolved against current data rather than this render's: the dialog and the lookup after
  // it both settle long after the click that opened them.
  const patchWorkspace = (wsId: string, path: string) =>
    onChange(id, (d) => ({
      workspaces: (d.workspaces ?? []).map((w) => (w.id === wsId ? { ...w, path } : w)),
    }));

  const setNote = (wsId: string, note: string) =>
    setNotes((all) => ({ ...all, [wsId]: note }));

  /**
   * Opens a folder chooser and fills the row with the folder that came back.
   *
   * The desktop's own chooser is asked first, through the proxy: it is the only route that
   * yields a real path, and it is the same dialog in every browser. Dismissing it changes
   * nothing, so a fresh row is left empty and can still be typed into.
   */
  const browse = async (wsId: string) => {
    setNote(wsId, "");
    setLocating((ids) => [...ids, wsId]);
    try {
      const native = await pickFolderNatively(workspaces.find((w) => w.id === wsId)?.path);
      if (native.path) return patchWorkspace(wsId, native.path);
      if (!native.unavailable) return; // dismissed
      await browseInBrowser(wsId);
    } catch {
      await browseInBrowser(wsId);
    } finally {
      setLocating((ids) => ids.filter((i) => i !== wsId));
    }
  };

  /**
   * The fallback, for a proxy with no desktop of its own. The browser's picker never says where
   * the folder is, so its name and contents go to the proxy to be matched against the real
   * filesystem — a guess, and labelled as one.
   */
  const browseInBrowser = async (wsId: string) => {
    const picked = await pickDirectory();
    if (!picked) return;

    // The name is the one thing known for certain, so it goes in immediately and the located
    // path replaces it a moment later.
    patchWorkspace(wsId, picked.name);
    try {
      const matches = await resolveFolder(picked.name, picked.entries);
      const [best, second] = matches;
      if (best) patchWorkspace(wsId, best.path);

      // A tie means the contents could not tell these apart, so the path below is a real
      // folder that may still be the wrong one. Say so rather than let it read as settled.
      if (!best) {
        setNote(wsId, `Could not find "${picked.name}" on this machine. Type its path.`);
      } else if (second && second.score === best.score) {
        setNote(wsId, `${matches.length} folders named "${picked.name}" match — check this is the right one.`);
      }
    } catch {
      setNote(wsId, `Could not look up "${picked.name}". Type its path.`);
    }
  };

  // The row is created before the dialog opens, so dismissing it still leaves a field behind
  // rather than undoing the click.
  const addWorkspace = () => {
    const ws: Workspace = { id: uid(), path: "" };
    setWorkspaces([...workspaces, ws]);
    void browse(ws.id);
  };

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
        <input
          className="label nodrag"
          value={data.label}
          onChange={(e) => onChange(id, { label: e.target.value })}
          aria-label="Step name"
        />
        <SkipToggle on={skipped} onChange={(v) => setSkipped(id, v)} title="Skip this node" />
        <DeleteButton onClick={() => onDelete(id)} title="Delete step" />
      </header>

      <div className="row">
        <label>
          Provider
          <select className="nodrag" value={provider}
            onChange={(e) => {
              const next = e.target.value as Provider;
              onChange(id, { provider: next, model: providerModels[next]?.[0] ?? "" });
            }}>
            {!providers.some((p) => p.provider === provider) &&
              <option value={provider} disabled>{providerNames[provider]} (not configured)</option>}
            {providers.map((p) => <option key={p.provider} value={p.provider}>{providerNames[p.provider]}</option>)}
          </select>
        </label>
      </div>

      <div className="row">
        <label>
          Model
          {models.length === 0 ? (
            <>
              <input className="line nodrag" value={data.model} list={`model-options-${id}`}
                placeholder={localModelsRequired ? "Downloaded Hugging Face model ID" : "Model ID served by your local server"}
                onChange={(e) => onChange(id, { model: e.target.value })} />
              <datalist id={`model-options-${id}`}>{models.map((model) => <option key={model} value={model} />)}</datalist>
            </>
          ) : <select
            className="nodrag"
            value={data.model}
            onChange={(e) => onChange(id, { model: e.target.value })}
          >
            {(models.includes(data.model) ? models : [data.model, ...models]).map((m) => (
              <option key={m} value={m} disabled={localModelsRequired && !models.includes(m)}>
                {m}{localModelsRequired && !models.includes(m) ? " (not downloaded)" : ""}
              </option>
            ))}
          </select>}
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
        <label title="Budget for the whole step: preparation, model loading, every round, and tool calls">
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

      <SandboxToggle useGpu={!!data.useGpu} onGpuChange={(v) => onChange(id, { useGpu: v })} required={localModelsRequired} on={localModelsRequired || !!data.sandbox} onChange={(v) => onChange(id, { sandbox: v })} />
      {(localModelsRequired || data.sandbox) && <SandboxRunStatus data={data} />}

      <div className="stack">
        <button
          className="file nodrag attach"
          onClick={addWorkspace}
        >
          <Icon name="folder" /> Add workspace
        </button>

        {workspaces.map((ws) => (
          <WorkspaceRow
            key={ws.id}
            path={ws.path}
            busy={locating.includes(ws.id)}
            note={notes[ws.id] || undefined}
            onChange={(path) => {
              // Editing the path by hand answers whatever the lookup was unsure about.
              patchWorkspace(ws.id, path);
              setNote(ws.id, "");
            }}
            onBrowse={() => void browse(ws.id)}
            onRemove={() => setWorkspaces(workspaces.filter((w) => w.id !== ws.id))}
          />
        ))}
      </div>

      <div className="stack">
        <label className="file nodrag attach">
          <Icon name="upload" /> Attach skill files (.md)
          <input
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            title=""
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
            title=""
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
