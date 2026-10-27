import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Effort, InputNode, LoopOutputMode, ToolConfig } from "../types";
import { Icon } from "../icons";
import { DEFAULT_LOOP_LIMIT, MAX_LOOP_LIMIT, normalizeLoopLimit } from "../loop";
import type { Provider } from "../api";
import { uid } from "../graph";
import { SandboxRunStatus } from "./SandboxRunStatus";
import { SandboxToggle } from "./SandboxToggle";
import { DeleteButton } from "./DeleteButton";
import { ToolEditor, BuiltinTool, WORKSPACE_TOOLS } from "./ToolEditor";
import { useGraphActions } from "./context";
import { CopyButton } from "./CopyButton";
import { parseInferenceConfiguration, serializeInferenceConfiguration } from "../inferenceConfig";

const EFFORTS: Effort[] = ["off", "minimal", "low", "medium", "high"];
const MAX_OUTPUTS = 8;
const ROUND_CHOICES = [1, 2, 4, 6, 8, 12, 16, 20, 30, 50];
const DEFAULT_ROUNDS = 12;
const TIMEOUT_CHOICES = [30, 60, 120, 300, 600, 900, 1800, 3600];
const DEFAULT_TIMEOUT_SEC = 300;
const asDuration = (seconds: number) => seconds < 60 ? `${seconds}s` : `${seconds / 60}m`;

export function InputNodeView({ id, data }: NodeProps<InputNode>) {
  const { activeNodeIds, stopNode, openSandboxConfig, providerModels, providerSettings, defaultProvider,
    currentId, workspaceCounts, updateInput: onChange, setLoop, runOne: onRun, removeNode: onDelete } = useGraphActions();
  const provider = data.provider ?? defaultProvider;
  const models = providerModels[provider] ?? [];
  const localModelsRequired = provider === "huggingface" && !!providerSettings?.providers?.find((value) => value.provider === provider)?.runLocally;
  const providers = providerSettings?.providers?.filter((value) => value.configured) ?? [];
  const providerNames = { openai: "OpenAI", compatible: "OpenAI-compatible", huggingface: "Hugging Face" };
  const busy = activeNodeIds.includes(id) || data.status === "running";
  const collapsed = !!data.collapsed;
  const current = currentId === id;
  const tools = data.tools ?? [];
  const workspaceCount = workspaceCounts[id] ?? 0;
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [flipDirection, setFlipDirection] = useState<"front" | "back" | null>(null);
  const [configurationDraft, setConfigurationDraft] = useState("");
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const setTools = (next: ToolConfig[]) => onChange(id, { tools: next });
  const patchTool = (toolId: string, patch: Partial<ToolConfig>) => setTools(tools.map((tool) => tool.id === toolId ? { ...tool, ...patch } : tool));

  const startFlip = (target: boolean) => {
    setConfigurationOpen(target);
    setFlipDirection(target ? "back" : "front");
  };

  const flipConfiguration = () => {
    if (!configurationOpen) {
      setConfigurationDraft(serializeInferenceConfiguration(data));
      setConfigurationError(null);
      startFlip(true);
      return;
    }
    try {
      const next = parseInferenceConfiguration(configurationDraft);
      onChange(id, {
        provider: next.provider,
        label: next.label ?? "Unnamed",
        model: next.model ?? "",
        effort: next.effort ?? "off",
        sandbox: next.sandbox,
        sandboxConfig: next.sandboxConfig,
        useGpu: next.useGpu,
        tools: next.tools,
        workspaceTools: next.workspaceTools,
        maxRounds: next.maxRounds,
        loopLimit: next.loopLimit,
        loopOutputMode: next.loopOutputMode,
        timeoutSec: next.timeoutSec,
        outputs: next.outputs ?? 1,
      });
      setLoop(id, next.loop ?? false);
      setConfigurationError(null);
      startFlip(false);
    } catch (error) {
      setConfigurationError((error as Error).message);
    }
  };

  const header = <header className="node-head">
    <input className={`label nodrag${data.label === "Unnamed" || data.label === "Name this step" ? " unnamed" : ""}`}
      placeholder="Unnamed" value={data.label} onChange={(event) => onChange(id, { label: event.target.value })}
      aria-label="Step name" />
    <button className="icon collapse-toggle nodrag" onClick={() => onChange(id, { collapsed: !collapsed })}
      aria-label={collapsed ? "Expand step" : "Collapse step"} aria-expanded={!collapsed}>
      <Icon name="chevron" size={13} />
    </button>
    <button className="icon configuration-toggle nodrag" onClick={flipConfiguration}
      disabled={flipDirection !== null}
      aria-label={configurationOpen ? "Apply inference configuration" : "Show inference configuration"}
      aria-pressed={configurationOpen}>
      <Icon name="eye" size={14} />
    </button>
    <DeleteButton onClick={() => onDelete(id)} title="Delete step" />
  </header>;

  return (
    <div className={`node input nopan${current ? " current" : ""} status-${data.status}${collapsed ? " collapsed" : ""}${configurationOpen ? " configuration-open" : ""}${flipDirection ? ` configuration-flipping configuration-to-${flipDirection}` : ""}`}>
      <Handle type="target" position={Position.Left} />
      {header}
      <div className="inference-card-stage"
        onAnimationEnd={(event) => {
          if (!event.animationName.includes("inference-card-flip-in-")) return;
          setFlipDirection(null);
        }}>
        <div className="inference-card-face inference-card-front" aria-hidden={configurationOpen}>
      <div className="row"><label>Provider
        <select className="nodrag" value={provider} onChange={(event) => {
          const next = event.target.value as Provider;
          onChange(id, { provider: next, model: providerModels[next]?.[0] ?? "" });
        }}>
          {!providers.some((value) => value.provider === provider) && <option value={provider} disabled>{providerNames[provider]} (not configured)</option>}
          {providers.map((value) => <option key={value.provider} value={value.provider}>{providerNames[value.provider]}</option>)}
        </select>
      </label></div>

      <div className="row"><label>Model
        {models.length === 0 ? <>
          <input className="line nodrag" value={data.model} list={`model-options-${id}`}
            placeholder={localModelsRequired ? "Downloaded Hugging Face model ID" : "Model ID served by your local server"}
            onChange={(event) => onChange(id, { model: event.target.value })} />
          <datalist id={`model-options-${id}`}>{models.map((model) => <option key={model} value={model} />)}</datalist>
        </> : <select className="nodrag" value={data.model} onChange={(event) => onChange(id, { model: event.target.value })}>
          {(models.includes(data.model) ? models : [data.model, ...models]).map((model) => <option key={model} value={model}
            disabled={localModelsRequired && !models.includes(model)}>{model}{localModelsRequired && !models.includes(model) ? " (not downloaded)" : ""}</option>)}
        </select>}
      </label></div>

      {!collapsed && <>
        <div className="row">
          <label>Thinking<select className="nodrag" value={data.effort} onChange={(event) => onChange(id, { effort: event.target.value as Effort })}>
            {EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </select></label>
          <label>Output N<select className="nodrag" value={data.outputs} onChange={(event) => onChange(id, { outputs: Number(event.target.value) })}>
            {Array.from({ length: MAX_OUTPUTS }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
          </select></label>
        </div>

        <div className="row">
          <label>Max Tool Turns<select className="nodrag" value={data.maxRounds ?? DEFAULT_ROUNDS} onChange={(event) => onChange(id, { maxRounds: Number(event.target.value) })}>
            {ROUND_CHOICES.map((count) => <option key={count} value={count}>{count}</option>)}
          </select></label>
          <label>Timeout<select className="nodrag" value={data.timeoutSec ?? DEFAULT_TIMEOUT_SEC} onChange={(event) => onChange(id, { timeoutSec: Number(event.target.value) })}>
            {TIMEOUT_CHOICES.map((seconds) => <option key={seconds} value={seconds}>{asDuration(seconds)}</option>)}
          </select></label>
        </div>

        <div className="sandbox-row loop-controls nodrag">
          <div className="loop-controls-main">
            <label className="sandbox-control"><span className="skip sandbox"><input type="checkbox" checked={!!data.loop}
              onChange={(event) => setLoop(id, event.target.checked)} /><span className="track" aria-hidden="true" /></span><span>Loop node</span></label>
            <label className="loop-limit"><input className="line nodrag" type="number" min={1} max={MAX_LOOP_LIMIT} step={1}
              value={data.loopLimit ?? DEFAULT_LOOP_LIMIT} aria-label="Loop iterations" disabled={!data.loop}
              onChange={(event) => onChange(id, { loopLimit: normalizeLoopLimit(Number(event.target.value)) })} /></label>
          </div>
          <select className="loop-output-mode nodrag" aria-label="Loop outputs" disabled={!data.loop}
            value={data.loopOutputMode ?? "last"} onChange={(event) => onChange(id, { loopOutputMode: event.target.value as LoopOutputMode })}>
            <option value="last">Last output</option><option value="all">All outputs</option>
          </select>
        </div>

        <div className="tools">
          <div className="tools-head"><span>Tools ({tools.length + (workspaceCount ? WORKSPACE_TOOLS.length : 0)})</span>
            <button className="nodrag add-tool" aria-label="Add a tool" onClick={() => setTools([...tools, {
              id: uid(), label: `Tool ${tools.length + 1}`, kind: "web_search", contextSize: "medium",
            }])}><Icon name="plus" /></button>
          </div>
          {workspaceCount > 0 && WORKSPACE_TOOLS.map((name) => <BuiltinTool key={name} name={name}
            enabled={data.workspaceTools?.[name] !== false}
            onChange={(enabled) => onChange(id, (current) => ({ workspaceTools: { ...current.workspaceTools, [name]: enabled } }))} />)}
          {tools.map((tool) => <ToolEditor key={tool.id} tool={tool} onChange={(patch) => patchTool(tool.id, patch)}
            onRemove={() => setTools(tools.filter((value) => value.id !== tool.id))} />)}
        </div>

        <SandboxToggle onConfigure={() => openSandboxConfig(id)} required={localModelsRequired}
          on={localModelsRequired || !!data.sandbox} onChange={(value) => onChange(id, { sandbox: value })} />
        {(localModelsRequired || data.sandbox) && <SandboxRunStatus data={data} />}
        {data.error && <p className="error nodrag">{data.error}</p>}
      </>}

      <button className={`run tinted ${busy ? "tint-err" : "tint-ok"} nodrag`} onClick={() => busy ? stopNode(id) : onRun(id)}>
        {busy ? <><Icon name="stop" /> {data.loop ? "Stop loop" : "Stop step"}</>
          : <><Icon name="play" /> {data.loop ? "Start loop" : "Run"}</>}
      </button>
        </div>

        <div className="inference-card-face inference-card-back" aria-hidden={!configurationOpen}>
          <div className="inference-configuration">
            <div className="field">
              <textarea className="configuration-json nodrag nowheel" value={configurationDraft}
                aria-label="Inference configuration JSON"
                onChange={(event) => {
                  setConfigurationDraft(event.target.value);
                  setConfigurationError(null);
                }} />
              <CopyButton text={configurationDraft} label="Copy inference configuration" />
            </div>
            {configurationError && <p className="error nodrag" role="alert">{configurationError}</p>}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
