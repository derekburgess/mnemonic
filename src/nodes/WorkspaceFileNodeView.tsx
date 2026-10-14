import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { WorkspaceFileNode } from "../types";
import { Icon } from "../icons";
import { CopyButton } from "./CopyButton";
import { useGraphActions } from "./context";
import { useFieldWidth } from "./useFieldWidth";

export function WorkspaceFileNodeView({ id, data }: NodeProps<WorkspaceFileNode>) {
  const { removeNode, updateWorkspaceFile } = useGraphActions();
  const collapsed = !!data.collapsed;
  const { min, field } = useFieldWidth();
  const [editing, setEditing] = useState(false);
  const [textHeight, setTextHeight] = useState<number | null>(null);
  const textProps = {
    style: { ...(min ? { minWidth: min } : {}), ...(textHeight ? { height: textHeight } : {}) },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      const dragged = event.currentTarget.style.height;
      if (dragged) setTextHeight(parseFloat(dragged));
      field().onPointerUp(event);
    },
  };

  return (
    <div className={`node output workspace-file nopan${collapsed ? " collapsed" : ""}`}>
      <header className="node-head workspace-file-head">
        <div className="meta">
          <strong>{data.name}</strong>
          <span className="dim workspace-file-path">{data.path}</span>
        </div>
        <button className="icon collapse-toggle output-collapse-toggle nodrag"
          onClick={() => updateWorkspaceFile(id, { collapsed: !collapsed })}
          aria-label={collapsed ? "Expand file" : "Collapse file"} aria-expanded={!collapsed}>
          <Icon name="chevron" size={13} />
        </button>
        <button className="icon workspace-file-close nodrag" onClick={() => removeNode(id)} aria-label="Close file">
          <Icon name="close" size={13} />
        </button>
      </header>

      {!collapsed && <div className="field">
        {editing ? (
          <textarea {...textProps} className="text nodrag nowheel" value={data.text} aria-label="File contents"
            onChange={(event) => updateWorkspaceFile(id, { text: event.target.value, edited: true })} />
        ) : (
          <div {...textProps} className="text md nodrag nowheel">
            {data.text ? <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{data.text}</Markdown>
              : <em className="dim">empty file</em>}
          </div>
        )}
        <button className={`copy edit-toggle nodrag${editing ? " editing" : ""}`}
          onClick={() => setEditing((value) => !value)} aria-label={editing ? "Done editing" : "Edit file contents"}>
          <Icon name={editing ? "check" : "pencil"} size={13} />
        </button>
        <CopyButton text={data.text} label="Copy file contents" />
      </div>}
      {data.edited && <footer className="dim workspace-file-footer">Edited</footer>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
