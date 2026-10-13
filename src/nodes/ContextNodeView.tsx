import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Attachment, ContextNode, InputFile, Workspace } from "../types";
import { pickFolderNatively, resolveFolder } from "../api";
import { pickDirectory } from "../pickDirectory";
import { uid } from "../graph";
import { Icon } from "../icons";
import { CopyButton } from "./CopyButton";
import { DeleteButton } from "./DeleteButton";
import { WorkspaceRow } from "./WorkspaceRow";
import { useGraphActions } from "./context";
import { useFieldWidth } from "./useFieldWidth";

export function ContextNodeView({ id, data }: NodeProps<ContextNode>) {
  const { updateContext: onChange, removeNode: onDelete } = useGraphActions();
  const collapsed = !!data.collapsed;
  const { field } = useFieldWidth();
  const [locating, setLocating] = useState<string[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const workspaces = data.workspaces ?? [];
  const attachments = data.attachments ?? [];
  const files = data.files ?? [];
  const links = data.links ?? [];

  const setWorkspaces = (next: Workspace[]) => onChange(id, { workspaces: next });
  const patchWorkspace = (wsId: string, path: string) => onChange(id, (current) => ({
    workspaces: (current.workspaces ?? []).map((workspace) => workspace.id === wsId ? { ...workspace, path } : workspace),
  }));

  const browseInBrowser = async (wsId: string) => {
    const picked = await pickDirectory();
    if (!picked) return;
    patchWorkspace(wsId, picked.name);
    try {
      const matches = await resolveFolder(picked.name, picked.entries);
      const [best, second] = matches;
      if (best) patchWorkspace(wsId, best.path);
      if (!best) setNotes((all) => ({ ...all, [wsId]: `Could not find "${picked.name}" on this machine. Type its path.` }));
      else if (second && second.score === best.score) setNotes((all) => ({ ...all, [wsId]: `${matches.length} folders named "${picked.name}" match — check this is the right one.` }));
    } catch {
      setNotes((all) => ({ ...all, [wsId]: `Could not look up "${picked.name}". Type its path.` }));
    }
  };

  const browse = async (wsId: string) => {
    setNotes((all) => ({ ...all, [wsId]: "" }));
    setLocating((ids) => [...ids, wsId]);
    try {
      const native = await pickFolderNatively(workspaces.find((workspace) => workspace.id === wsId)?.path);
      if (native.path) patchWorkspace(wsId, native.path);
      else if (native.unavailable) await browseInBrowser(wsId);
    } catch {
      await browseInBrowser(wsId);
    } finally {
      setLocating((ids) => ids.filter((value) => value !== wsId));
    }
  };

  const addWorkspace = () => {
    const workspace = { id: uid(), path: "" };
    setWorkspaces([...workspaces, workspace]);
    void browse(workspace.id);
  };

  const attachSkills = async (picked: FileList) => {
    const read = await Promise.all([...picked].map(async (file) => ({ id: uid(), name: file.name, text: await file.text() })));
    onChange(id, { attachments: [...attachments, ...read] as Attachment[] });
  };

  const attachFiles = async (picked: FileList) => {
    const read = await Promise.all([...picked].map((file) => new Promise<InputFile>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ id: uid(), name: file.name, mime: file.type || "application/octet-stream", dataUrl: String(reader.result) });
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    })));
    onChange(id, { files: [...files, ...read] });
  };

  return (
    <div className={`node context nopan${collapsed ? " collapsed" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <header className="node-head">
        <input className={`label nodrag${data.label === "Unnamed" ? " unnamed" : ""}`}
          placeholder="Unnamed" value={data.label} aria-label="Context name"
          onChange={(event) => onChange(id, { label: event.target.value })} />
        <button className="icon collapse-toggle nodrag" onClick={() => onChange(id, { collapsed: !collapsed })}
          aria-label={collapsed ? "Expand context" : "Collapse context"} aria-expanded={!collapsed}>
          <Icon name="chevron" size={13} />
        </button>
        <DeleteButton onClick={() => onDelete(id)} title="Delete context" />
      </header>

      {!collapsed && <>
        <div className="stack">
          <button className="file nodrag attach" onClick={addWorkspace}><Icon name="folder" /> Add workspace</button>
          {workspaces.map((workspace) => <WorkspaceRow key={workspace.id} path={workspace.path}
            busy={locating.includes(workspace.id)} note={notes[workspace.id] || undefined}
            onChange={(path) => { patchWorkspace(workspace.id, path); setNotes((all) => ({ ...all, [workspace.id]: "" })); }}
            onBrowse={() => void browse(workspace.id)}
            onRemove={() => setWorkspaces(workspaces.filter((value) => value.id !== workspace.id))} />)}
        </div>

        <div className="stack">
          <label className="file nodrag attach"><Icon name="upload" /> Attach skill files (.md)
            <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" title="" multiple
              onChange={(event) => { if (event.target.files?.length) void attachSkills(event.target.files); event.target.value = ""; }} />
          </label>
          {attachments.map((file) => <div className="attachment" key={file.id} title={`${file.name} — ${file.text.length} characters`}>
            <span className="attachment-name">{file.name}</span>
            <button className="icon tinted tint-err nodrag" onClick={() => onChange(id, { attachments: attachments.filter((value) => value.id !== file.id) })}
              aria-label={`Remove ${file.name}`}><Icon name="close" size={11} /></button>
          </div>)}
        </div>

        <div className="stack">
          <label className="file nodrag attach"><Icon name="upload" /> Attach files (.pdf, .txt, .png, .jpg)
            <input type="file" accept=".pdf,.txt,.png,.jpg,.jpeg,application/pdf,text/plain,image/png,image/jpeg" title="" multiple
              onChange={(event) => { if (event.target.files?.length) void attachFiles(event.target.files); event.target.value = ""; }} />
          </label>
          {files.map((file) => <div className="attachment" key={file.id} title={`${file.name} — ${file.mime}`}>
            <span className="attachment-name">{file.name}</span>
            <button className="icon tinted tint-err nodrag" onClick={() => onChange(id, { files: files.filter((value) => value.id !== file.id) })}
              aria-label={`Remove ${file.name}`}><Icon name="close" size={11} /></button>
          </div>)}
        </div>

        <div className="stack">
          <button className="file nodrag attach" onClick={() => onChange(id, { links: [...links, { id: uid(), url: "" }] })}>
            <Icon name="plus" /> Add links
          </button>
          {links.map((link) => <div className="attachment" key={link.id}>
            <input className="line nodrag" placeholder="https://…" value={link.url} aria-label="Link URL"
              onChange={(event) => onChange(id, { links: links.map((value) => value.id === link.id ? { ...value, url: event.target.value } : value) })} />
            <button className="icon tinted tint-err nodrag" onClick={() => onChange(id, { links: links.filter((value) => value.id !== link.id) })}
              aria-label="Remove link"><Icon name="close" size={11} /></button>
          </div>)}
        </div>

        <label className="stack">Role
          <input className="line nodrag" value={data.role ?? ""} onChange={(event) => onChange(id, { role: event.target.value })} />
        </label>
        <label className="stack">Instructions (System Prompt + Role)
          <div className="field"><textarea {...field()} className="instructions nodrag nowheel" value={data.instructions ?? ""}
            onChange={(event) => onChange(id, { instructions: event.target.value })} />
            <CopyButton text={data.instructions ?? ""} label="Copy instructions" />
          </div>
        </label>
      </>}
      <label className="stack">Input
        <div className="field"><textarea {...field()} className="prompt nodrag nowheel" value={data.prompt}
          onChange={(event) => onChange(id, { prompt: event.target.value })} />
          <CopyButton text={data.prompt} label="Copy input" />
        </div>
      </label>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
