import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { fetchMcpTools, type McpTool } from "../api";
import type { ToolKind, ToolNode } from "../types";
import { Icon } from "../icons";
import { CopyButton } from "./CopyButton";
import { DeleteButton } from "./DeleteButton";
import { SkipToggle } from "./SkipToggle";
import { useGraphActions } from "./context";
import { useFieldWidth } from "./useFieldWidth";

const KINDS: { value: ToolKind; label: string }[] = [
  { value: "web_search", label: "Web search" },
  { value: "mcp", label: "MCP" },
  { value: "custom", label: "Custom" },
];

export function ToolNodeView({ id, data }: NodeProps<ToolNode>) {
  const { updateTool, removeNode, setSkipped } = useGraphActions();
  const skipped = !!data.skipped;
  const { field } = useFieldWidth();

  const [mcpTools, setMcpTools] = useState<McpTool[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMcpTools = async () => {
    setLoading(true);
    setError(null);
    try {
      const { tools, resolvedUrl } = await fetchMcpTools(data.serverUrl ?? "", data.authorization);
      setMcpTools(tools);
      // If the server turned out to be mounted elsewhere, keep the URL that actually worked.
      if (resolvedUrl !== data.serverUrl) updateTool(id, { serverUrl: resolvedUrl });
    } catch (err) {
      setError((err as Error).message);
      setMcpTools(null);
    } finally {
      setLoading(false);
    }
  };

  const toggleTool = (name: string) => {
    const current = data.selectedTools ?? [];
    updateTool(id, {
      selectedTools: current.includes(name) ? current.filter((t) => t !== name) : [...current, name],
    });
  };

  return (
    <div className={`node tool${skipped ? " skipped" : ""}`}>
      <Handle type="target" position={Position.Left} />

      <header className="node-head">
        <input
          className="label nodrag"
          value={data.label}
          onChange={(e) => updateTool(id, { label: e.target.value })}
          aria-label="Tool name"
        />
        <SkipToggle on={skipped} onChange={(v) => setSkipped(id, v)} title="Withhold this tool from its steps" />
        <DeleteButton onClick={() => removeNode(id)} title="Delete tool" />
      </header>

      <div className="row">
        <label>
          Type
          <select
            className="nodrag"
            value={data.kind}
            onChange={(e) => updateTool(id, { kind: e.target.value as ToolKind })}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {data.kind === "web_search" && (
        <>
          <div className="row">
            <label>
              Context size
              <select
                className="nodrag"
                value={data.contextSize ?? "medium"}
                onChange={(e) =>
                  updateTool(id, { contextSize: e.target.value as "low" | "medium" | "high" })
                }
              >
                {["low", "medium", "high"].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="stack">
            Allowed domains (comma separated, blank for any)
            <input
              className="line nodrag"
              value={data.allowedDomains ?? ""}
              onChange={(e) => updateTool(id, { allowedDomains: e.target.value })}
            />
          </label>
        </>
      )}

      {data.kind === "mcp" && (
        <>
          <label className="stack">
            Server URL
            <input
              className="line nodrag"
              value={data.serverUrl ?? ""}
              onChange={(e) => updateTool(id, { serverUrl: e.target.value })}
            />
          </label>
          <label className="stack">
            Authorization (optional)
            <input
              className="line nodrag"
              type="password"
              value={data.authorization ?? ""}
              onChange={(e) => updateTool(id, { authorization: e.target.value })}
            />
          </label>

          <button className="nodrag" onClick={loadMcpTools} disabled={loading || !data.serverUrl}>
            <Icon name="gear" /> {loading ? "Connecting…" : mcpTools ? "Refresh tools" : "List tools"}
          </button>

          {mcpTools && (
            <div className="stack">
              <span>
                Tools ({(data.selectedTools ?? []).length || "all"} of {mcpTools.length} selected)
              </span>
              <div {...field()} className="picker nodrag nowheel">
                {mcpTools.map((t) => (
                  <label key={t.name} className="pick" title={t.description}>
                    <input
                      type="checkbox"
                      checked={(data.selectedTools ?? []).includes(t.name)}
                      onChange={() => toggleTool(t.name)}
                    />
                    <span>{t.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {data.kind === "custom" && (
        <>
          <label className="stack">
            Function name
            <input
              className="line nodrag"
              value={data.fnName ?? ""}
              onChange={(e) => updateTool(id, { fnName: e.target.value })}
            />
          </label>
          <label className="stack">
            Description
            <input
              className="line nodrag"
              value={data.fnDescription ?? ""}
              onChange={(e) => updateTool(id, { fnDescription: e.target.value })}
            />
          </label>
          <label className="stack">
            Parameters (JSON Schema)
            <div className="field">
              <textarea
                {...field()}
                className="instructions nodrag nowheel"
                value={data.fnParameters ?? ""}
                onChange={(e) => updateTool(id, { fnParameters: e.target.value })}
              />
              <CopyButton text={data.fnParameters ?? ""} title="Copy parameters" />
            </div>
          </label>
          <label className="stack">
            Code — `args` is in scope, return a value
            <div className="field">
              <textarea
                {...field()}
                className="prompt code nodrag nowheel"
                value={data.fnCode ?? ""}
                onChange={(e) => updateTool(id, { fnCode: e.target.value })}
              />
              <CopyButton text={data.fnCode ?? ""} title="Copy code" />
            </div>
          </label>
        </>
      )}

      {error && <p className="error nodrag">{error}</p>}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
