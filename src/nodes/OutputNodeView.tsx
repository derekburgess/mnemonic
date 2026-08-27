import { Handle, Position, useStore, type NodeProps } from "@xyflow/react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { OutputNode } from "../types";
import { CopyButton } from "./CopyButton";
import { DeleteButton } from "./DeleteButton";
import { SkipToggle } from "./SkipToggle";
import { useGraphActions } from "./context";

export function OutputNodeView({ id, data }: NodeProps<OutputNode>) {
  const { removeNode: onDelete, setSkipped } = useGraphActions();
  const skipped = !!data.skipped;
  // A detached artifact is history: still on the canvas, but out of the current flow. With a
  // tool in the chain the artifact hangs off the tool, so tool edges count here.
  const attached = useStore((s) => s.edges.some((e) => e.source === id || e.target === id));
  const stamp = new Date(data.createdAt).toLocaleTimeString();
  const tokens = data.usage
    ? `Tokens: ${data.usage.input ?? "?"} in / ${data.usage.output ?? "?"} out`
    : null;

  return (
    <div className={`node output${attached ? "" : " detached"}${skipped ? " skipped" : ""}`}>
      <Handle type="target" position={Position.Top} />

      <header className="node-head">
        <div className="meta">
          <strong>{data.model}</strong>
          <span className="dim">
            {data.sourceLabel} · {data.effort} · {stamp}
          </span>
        </div>
        <SkipToggle on={skipped} onChange={(v) => setSkipped(id, v)} title="Withhold this output from downstream context" />
        <DeleteButton onClick={() => onDelete(id)} title="Delete output" />
      </header>

      <div className="field">
        <div className="text md nodrag nowheel">
          {data.text ? (
            // GFM for tables and strikethrough; breaks so single newlines survive as written.
            <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{data.text}</Markdown>
          ) : (
            <em className="dim">empty response</em>
          )}
        </div>
        <CopyButton text={data.text} title="Copy output" />
      </div>
      {/* One row per thing: a call's arguments, then each URL it produced. */}
      {(data.toolCalls ?? [])
        .flatMap((call) => [
          ...(call.detail ? [{ name: call.name, text: call.detail, href: undefined }] : []),
          ...(call.urls ?? []).map((url) => ({ name: call.name, text: url, href: url })),
        ])
        .map((row, i) => (
          <div className="call" key={i}>
            <span className="call-name" title={row.name}>
              {row.name}
            </span>
            <div className="field">
              <div className="call-detail nodrag nowheel">
                {row.href ? (
                  <a href={row.href} target="_blank" rel="noreferrer noopener" title={row.href}>
                    {row.text.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  <span className="call-args">{row.text}</span>
                )}
              </div>
              <CopyButton text={row.text} title={row.href ? "Copy URL" : "Copy arguments"} />
            </div>
          </div>
        ))}

      {tokens && <footer className="dim tokens">{tokens}</footer>}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
