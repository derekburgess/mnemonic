import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { CommentNode } from "../types";
import { Icon } from "../icons";
import { CopyButton } from "./CopyButton";
import { DeleteButton } from "./DeleteButton";
import { useGraphActions } from "./context";
import { useFieldWidth } from "./useFieldWidth";

export function CommentNodeView({ id, data }: NodeProps<CommentNode>) {
  const { updateComment, removeNode } = useGraphActions();
  const { min, field } = useFieldWidth();
  const [editing, setEditing] = useState(!data.text);
  const [textHeight, setTextHeight] = useState<number | null>(null);
  const textProps = {
    style: {
      ...(min ? { minWidth: min } : {}),
      ...(textHeight ? { height: textHeight } : {}),
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      const dragged = event.currentTarget.style.height;
      if (dragged) setTextHeight(parseFloat(dragged));
      field().onPointerUp(event);
    },
  };

  return (
    <div className="node output comment nopan">
      <header className="node-head">
        <input className="label nodrag" value={data.author} placeholder="Your name"
          aria-label="Comment author" onChange={(event) => updateComment(id, { author: event.target.value })} />
        <DeleteButton onClick={() => removeNode(id)} title="Delete comment" />
      </header>

      <div className="field">
        {editing ? (
          <textarea {...textProps} className="text nodrag nowheel" value={data.text}
            placeholder="Write a comment…" aria-label="Comment text"
            onChange={(event) => updateComment(id, { text: event.target.value })} />
        ) : (
          <div {...textProps} className="text md nodrag nowheel">
            {data.text
              ? <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{data.text}</Markdown>
              : <em className="dim">empty comment</em>}
          </div>
        )}
        <button className={`copy edit-toggle nodrag${editing ? " editing" : ""}`}
          onClick={() => setEditing((value) => !value)}
          title={editing ? "Preview comment" : "Edit comment"}
          aria-label={editing ? "Preview comment" : "Edit comment"}>
          <Icon name="pencil" size={13} />
        </button>
        <CopyButton text={data.text} title="Copy comment" />
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
