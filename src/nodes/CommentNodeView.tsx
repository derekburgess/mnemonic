import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
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
  replyNumber?: number;
  onChange: (patch: Pick<CommentReply, "author"> | Pick<CommentReply, "text">) => void;
  onDelete: () => void;
};

/** One message in a comment thread. Replies deliberately share the original's Markdown controls. */
function CommentMessage({ author, text, replyNumber, onChange, onDelete }: MessageProps) {
  const { min, field } = useFieldWidth();
  const [editing, setEditing] = useState(!text);
  const [textHeight, setTextHeight] = useState<number | null>(null);
  const isReply = replyNumber !== undefined;
  const prefix = isReply ? `Reply ${replyNumber}` : "Comment";
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
    <section className={`comment-message${isReply ? " comment-reply" : ""}`}>
      <header className="node-head">
        <input
          className="label nodrag"
          value={author}
          placeholder="Your name"
          aria-label={`${prefix} author`}
          onChange={(event) => onChange({ author: event.target.value })}
        />
        <DeleteButton onClick={onDelete} title={isReply ? `Delete reply ${replyNumber}` : "Delete comment"} />
      </header>

      <div className="field">
        {editing ? (
          <textarea
            {...textProps}
            className="text nodrag nowheel"
            value={text}
            placeholder={isReply ? "Write a reply…" : "Write a comment…"}
            aria-label={`${prefix} text`}
            onChange={(event) => onChange({ text: event.target.value })}
          />
        ) : (
          <div {...textProps} className="text md nodrag nowheel">
            {text
              ? <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</Markdown>
              : <em className="dim">empty {isReply ? "reply" : "comment"}</em>}
          </div>
        )}
        <button
          className={`copy edit-toggle nodrag${editing ? " editing" : ""}`}
          onClick={() => setEditing((value) => !value)}
          title={editing ? `Preview ${prefix.toLowerCase()}` : `Edit ${prefix.toLowerCase()}`}
          aria-label={editing ? `Preview ${prefix.toLowerCase()}` : `Edit ${prefix.toLowerCase()}`}
        >
          <Icon name="pencil" size={13} />
        </button>
        <CopyButton text={text} title={`Copy ${prefix.toLowerCase()}`} />
      </div>
    </section>
  );
}

export function CommentNodeView({ id, data }: NodeProps<CommentNode>) {
  const { updateComment, removeNode } = useGraphActions();
  const replies = data.replies ?? [];

  const updateReply = (replyId: string, patch: Pick<CommentReply, "author"> | Pick<CommentReply, "text">) => {
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
