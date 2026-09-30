import { useState } from "react";
import { fetchMcpTools, type McpTool } from "../api";
import type { ToolConfig, ToolKind } from "../types";
import { Icon } from "../icons";
import { CopyButton } from "./CopyButton";
import { DeleteButton } from "./DeleteButton";
import { useFieldWidth } from "./useFieldWidth";

/** Optional invocation limits, capped by the node’s remaining budget. */
const TIMEOUT_CHOICES = [5, 15, 30, 60, 120, 300, 600, 900, 1800];
const asDuration = (sec: number) => (sec < 60 ? `${sec}s` : `${sec / 60}m`);

const KINDS: { value: ToolKind; label: string }[] = [
  { value: "web_search", label: "Web search" },
  { value: "mcp", label: "MCP" },
  { value: "custom", label: "Custom" },
];

/** One tool belonging to a step: the same controls the tool node used to carry. */
export function ToolEditor({
  tool,
  onChange,
  onRemove,
}: {
  tool: ToolConfig;
  onChange: (patch: Partial<ToolConfig>) => void;
  onRemove: () => void;
}) {
  const { field } = useFieldWidth();
  const [mcpTools, setMcpTools] = useState<McpTool[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const loadMcpTools = async () => {
    setLoading(true);
    setError(null);
    try {
      const { tools, resolvedUrl } = await fetchMcpTools(tool.serverUrl ?? "", tool.authorization);
      setMcpTools(tools);
      // If the server turned out to be mounted elsewhere, keep the URL that actually worked.
      if (resolvedUrl !== tool.serverUrl) onChange({ serverUrl: resolvedUrl });
    } catch (err) {
      setError((err as Error).message);
      setMcpTools(null);
    } finally {
      setLoading(false);
    }
  };

  const toggleTool = (name: string) => {
    const current = tool.selectedTools ?? [];
    onChange({
      selectedTools: current.includes(name)
        ? current.filter((t) => t !== name)
        : [...current, name],
    });
  };

  return (
    <div className="tool">
      <header className="tool-head">
        <button className="tool-toggle nodrag" onClick={() => setOpen((v) => !v)}>
          <span className={`caret${open ? " open" : ""}`}>›</span>
          <input
            className="label nodrag"
            value={tool.label}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onChange({ label: e.target.value })}
            aria-label="Tool name"
          />
        </button>
        <ToolEnabledToggle name={tool.label} enabled={tool.enabled !== false} onChange={(enabled) => onChange({ enabled })} />
        <DeleteButton onClick={onRemove} title="Remove tool" />
      </header>

      {open && (
        <div className="tool-body">
          <div className="row">
            <label>
              Type
              <select
                className="nodrag"
                value={tool.kind}
                onChange={(e) => onChange({ kind: e.target.value as ToolKind })}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

    {tool.kind === "web_search" && (
      <>
        <div className="row">
          <label>
            Context size
            <select
              className="nodrag"
              value={tool.contextSize ?? "medium"}
              onChange={(e) =>
                onChange({ contextSize: e.target.value as "low" | "medium" | "high" })
              }
            >
              {["low", "medium", "high"].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          {tool.kind !== "web_search" && (
            <label title="Use the node’s remaining timeout, or set a shorter limit for each tool invocation">
              Timeout
              <select
                className="nodrag"
                value={tool.timeoutSec ?? ""}
                onChange={(e) => onChange({ timeoutSec: e.target.value ? Number(e.target.value) : undefined })}
              >
                <option value="">Use node timeout</option>
                {TIMEOUT_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {asDuration(n)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <label className="stack">
          Allowed domains (comma separated, blank for any)
          <input
            className="line nodrag"
            value={tool.allowedDomains ?? ""}
            onChange={(e) => onChange({ allowedDomains: e.target.value })}
          />
        </label>
      </>
    )}

    {tool.kind === "mcp" && (
      <>
        <label className="stack">
          Server URL
          <input
            className="line nodrag"
            value={tool.serverUrl ?? ""}
            onChange={(e) => onChange({ serverUrl: e.target.value })}
          />
        </label>
        <label className="stack">
          Authorization (optional)
          <input
            className="line nodrag"
            type="password"
            value={tool.authorization ?? ""}
            onChange={(e) => onChange({ authorization: e.target.value })}
          />
        </label>

        <button className="nodrag" onClick={loadMcpTools} disabled={loading || !tool.serverUrl}>
          <Icon name="gear" /> {loading ? "Connecting…" : mcpTools ? "Refresh tools" : "List tools"}
        </button>

        {mcpTools && (
          <div className="stack">
            <span>
              Tools ({(tool.selectedTools ?? []).length || "all"} of {mcpTools.length} selected)
            </span>
            <div {...field()} className="picker nodrag nowheel">
              {mcpTools.map((t) => (
                <label key={t.name} className="pick" title={t.description}>
                  <input
                    type="checkbox"
                    checked={(tool.selectedTools ?? []).includes(t.name)}
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

    {tool.kind === "custom" && (
      <>
        <label className="stack">
          Function name
          <input
            className="line nodrag"
            value={tool.fnName ?? ""}
            onChange={(e) => onChange({ fnName: e.target.value })}
          />
        </label>
        <label className="stack">
          Description
          <input
            className="line nodrag"
            value={tool.fnDescription ?? ""}
            onChange={(e) => onChange({ fnDescription: e.target.value })}
          />
        </label>
        <label className="stack">
          Parameters (JSON Schema)
          <div className="field">
            <textarea
              {...field()}
              className="instructions nodrag nowheel"
              value={tool.fnParameters ?? ""}
              onChange={(e) => onChange({ fnParameters: e.target.value })}
            />
            <CopyButton text={tool.fnParameters ?? ""} title="Copy parameters" />
          </div>
        </label>
        <label className="stack">
          Code — `args` is in scope, return a value
          <div className="field">
            <textarea
              {...field()}
              className="prompt code nodrag nowheel"
              value={tool.fnCode ?? ""}
              onChange={(e) => onChange({ fnCode: e.target.value })}
            />
            <CopyButton text={tool.fnCode ?? ""} title="Copy code" />
          </div>
        </label>
      </>
    )}

          {error && <p className="error nodrag">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function ToolEnabledToggle({ name, enabled, onChange }: { name: string; enabled: boolean; onChange: (enabled: boolean) => void }) {
  return <label className="skip sandbox nodrag">
    <input type="checkbox" aria-label={`Enable ${name}`} checked={enabled} onChange={(e) => onChange(e.target.checked)} />
    <span className="track" aria-hidden="true" />
  </label>;
}

export const WORKSPACE_TOOLS = ["workspace_list", "workspace_read", "workspace_write"] as const;

export function BuiltinTool({ name, enabled, onChange }: { name: string; enabled: boolean; onChange: (enabled: boolean) => void }) {
  return <div className="tool"><header className="tool-head">
    <span className="builtin-tool-name">{name}</span><span className="dim">Built-in</span>
    <ToolEnabledToggle name={name} enabled={enabled} onChange={onChange} />
    <DeleteButton disabled onClick={() => {}} title="Remove tool" />
  </header></div>;
}
