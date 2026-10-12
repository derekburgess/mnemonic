import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { uid } from "../graph";
import { Icon } from "../icons";
import type { CommentNode, CommentReply } from "../types";
import { CopyButton } from "./CopyButton";
import { DeleteButton } from "./DeleteButton";
import { useGraphActions } from "./context";
import { useFieldWidth } from "./useFieldWidth";

type MessageProps = {
  author: string;
  text: string;
  createdAt: number;
  collapsed?: boolean;
  replyNumber?: number;
  onChange: (patch: Partial<Pick<CommentReply, "author" | "text" | "collapsed">>) => void;
  onDelete: () => void;
};

/** One directly editable message in a comment thread. */
function CommentMessage({ author, text, createdAt, collapsed = false, replyNumber, onChange, onDelete }: MessageProps) {
  const { min, field } = useFieldWidth();
  const [textHeight, setTextHeight] = useState<number | null>(null);
  const isReply = replyNumber !== undefined;
  const prefix = isReply ? `Reply ${replyNumber}` : "Comment";
  const created = new Date(createdAt);
  const validDate = Number.isFinite(created.getTime());
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
    <section className={`comment-message${isReply ? " comment-reply" : ""}${collapsed ? " collapsed" : ""}`}>
      <header className="node-head comment-head">
        <div className="comment-author">
          <input
            className="label nodrag"
            value={author}
            placeholder="Your name"
            aria-label={`${prefix} author`}
            onChange={(event) => onChange({ author: event.target.value })}
          />
          <time className="dim comment-time" dateTime={validDate ? created.toISOString() : undefined}>
            {validDate ? created.toLocaleString() : "Unknown time"}
          </time>
        </div>
        <button
          className="icon collapse-toggle comment-collapse-toggle nodrag"
          onClick={() => onChange({ collapsed: !collapsed })}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${prefix.toLowerCase()}`}
          aria-expanded={!collapsed}
        >
          <Icon name="chevron" size={13} />
        </button>
        <DeleteButton onClick={onDelete} title={isReply ? `Delete reply ${replyNumber}` : "Delete comment"} />
      </header>

      {!collapsed && <div className="field">
        <textarea
          {...textProps}
          className="text nodrag nowheel"
          value={text}
          placeholder={isReply ? "Write a reply…" : "Write a comment…"}
          aria-label={`${prefix} text`}
          onChange={(event) => onChange({ text: event.target.value })}
        />
        <CopyButton text={text} label={`Copy ${prefix.toLowerCase()}`} />
      </div>}
    </section>
  );
}

export function CommentNodeView({ id, data }: NodeProps<CommentNode>) {
  const { updateComment, removeNode } = useGraphActions();
  const replies = data.replies ?? [];

  const updateReply = (replyId: string, patch: Partial<Pick<CommentReply, "author" | "text" | "collapsed">>) => {
    updateComment(id, (current) => ({
      replies: (current.replies ?? []).map((reply) => reply.id === replyId ? { ...reply, ...patch } : reply),
    }));
  };

  const removeReply = (replyId: string) => {
    updateComment(id, (current) => ({ replies: (current.replies ?? []).filter((reply) => reply.id !== replyId) }));
  };

  const addReply = () => {
    updateComment(id, (current) => ({
      replies: [...(current.replies ?? []), { id: uid(), author: "", text: "", createdAt: Date.now() }],
    }));
  };

  return (
    <div className="node output comment nopan">
      <CommentMessage
        author={data.author}
        text={data.text}
        createdAt={data.createdAt}
        collapsed={data.collapsed}
        onChange={(patch) => updateComment(id, patch)}
        onDelete={() => removeNode(id)}
      />

      {replies.length > 0 && (
        <div className="comment-replies">
          {replies.map((reply, index) => (
            <CommentMessage
              key={reply.id}
              author={reply.author}
              text={reply.text}
              createdAt={reply.createdAt}
              collapsed={reply.collapsed}
              replyNumber={index + 1}
              onChange={(patch) => updateReply(reply.id, patch)}
              onDelete={() => removeReply(reply.id)}
            />
          ))}
        </div>
      )}

      <button className="comment-reply-button nodrag" onClick={addReply}>
        <Icon name="plus" size={13} /> Reply
      </button>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
