import { Handle, Position, useStore, type NodeProps } from "@xyflow/react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { OutputNode } from "../types";
import { CopyButton } from "./CopyButton";
import { DeleteButton } from "./DeleteButton";
import { SkipToggle } from "./SkipToggle";
import { useGraphActions } from "./context";
import { useFieldWidth } from "./useFieldWidth";

/** Mirrors .call-name width and .call gap in the stylesheet. */
const NAME_COLUMN = 150;
const ROW_GAP = 6;

export function OutputNodeView({ id, data }: NodeProps<OutputNode>) {
  const { removeNode: onDelete, setSkipped } = useGraphActions();
  const skipped = !!data.skipped;

  const { min, field } = useFieldWidth();
  // A detached artifact is history: still on the canvas, but out of the current flow. With a
  // tool in the chain the artifact hangs off the tool, so tool edges count here.
  const attached = useStore((s) => s.edges.some((e) => e.source === id || e.target === id));
  const stamp = new Date(data.createdAt).toLocaleTimeString();
  const tokens = data.usage
    ? `Tokens: ${data.usage.input ?? "?"} in / ${data.usage.output ?? "?"} out`
    : null;

  return (
    <div className={`node output${attached ? "" : " detached"}${skipped ? " skipped" : ""}`}>
      <Handle type="target" position={Position.Left} />

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
        <div {...field()} className="text md nodrag nowheel">
          {data.text ? (
            // GFM for tables and strikethrough; breaks so single newlines survive as written.
            <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{data.text}</Markdown>
          ) : (
            <em className="dim">empty response</em>
          )}
        </div>
        <CopyButton text={data.text} title="Copy output" />
      </div>
      {/*
        One row per thing: a call's arguments, then each URL it produced. Every call gets a row
        even with no arguments and no URLs, or it would vanish from the record entirely.
      */}
      {(data.toolCalls ?? [])
        .flatMap((call) => {
          const urls = call.urls ?? [];
          const args =
            call.detail || urls.length === 0
              ? [{ name: call.name, text: call.detail ?? "", href: undefined }]
              : [];
          return [...args, ...urls.map((url) => ({ name: call.name, text: url, href: url }))];
        })
        .map((row, i) => (
          <div className="call" key={i} style={min ? { minWidth: min } : undefined}>
            <span className="call-name" title={row.name}>
              {row.name}
            </span>
            <div className="field nodrag" onPointerUp={field(NAME_COLUMN + ROW_GAP).onPointerUp}>
              <div className="call-detail nowheel" title={row.text}>
                {row.href ? (
                  <a href={row.href} target="_blank" rel="noreferrer noopener" title={row.href}>
                    {row.text.replace(/^https?:\/\//, "")}
                  </a>
                ) : row.text ? (
                  <span className="call-args">{row.text}</span>
                ) : (
                  <span className="dim">no arguments</span>
                )}
              </div>
              <CopyButton text={row.text} title={row.href ? "Copy URL" : "Copy arguments"} />
            </div>
          </div>
        ))}

      {tokens && <footer className="dim tokens">{tokens}</footer>}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
