import type { InputData, ToolConfig } from "./types";

const PROVIDERS = new Set(["openai", "compatible", "huggingface"]);
const EFFORTS = new Set(["off", "minimal", "low", "medium", "high"]);
const LOOP_MODES = new Set(["last", "all"]);
const TOOL_KINDS = new Set(["web_search", "mcp", "custom"]);

export type InferenceConfiguration = Partial<Pick<InputData,
  "provider" | "label" | "model" | "effort" | "sandbox" | "sandboxConfig" | "useGpu" |
  "tools" | "workspaceTools" | "maxRounds" | "loop" | "loopLimit" | "loopOutputMode" |
  "timeoutSec" | "outputs"
>>;

/** The portable part of an inference node, without UI state or details from its last execution. */
export function inferenceConfiguration(data: InputData): InferenceConfiguration {
  const { provider, label, model, effort, sandbox, sandboxConfig, useGpu, tools, workspaceTools,
    maxRounds, loop, loopLimit, loopOutputMode, timeoutSec, outputs } = data;
  const configuration = { provider, label, model, effort, sandbox, sandboxConfig, useGpu, tools, workspaceTools,
    maxRounds, loop, loopLimit, loopOutputMode, timeoutSec, outputs };
  return Object.fromEntries(Object.entries(configuration).filter(([, value]) => value !== undefined)) as InferenceConfiguration;
}

export const serializeInferenceConfiguration = (data: InputData) =>
  JSON.stringify(inferenceConfiguration(data), null, 2);

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const optional = (value: unknown, kind: "string" | "boolean" | "number", name: string) => {
  if (value !== undefined && typeof value !== kind) throw new Error(`${name} must be a ${kind}.`);
};

/** Accept either the configuration itself or one exported node object containing `data`. */
export function parseInferenceConfiguration(text: string): InferenceConfiguration {
  const parsed: unknown = JSON.parse(text);
  if (!object(parsed)) throw new Error("Inference configuration must be a JSON object.");
  const source = object(parsed.data) ? parsed.data : parsed;

  optional(source.provider, "string", "provider");
  if (source.provider !== undefined && !PROVIDERS.has(source.provider as string)) throw new Error("provider is not supported.");
  optional(source.label, "string", "label");
  optional(source.model, "string", "model");
  optional(source.effort, "string", "effort");
  if (source.effort !== undefined && !EFFORTS.has(source.effort as string)) throw new Error("effort is not supported.");
  for (const key of ["sandbox", "useGpu", "loop"] as const) optional(source[key], "boolean", key);
  optional(source.sandboxConfig, "string", "sandboxConfig");
  for (const key of ["maxRounds", "loopLimit", "timeoutSec", "outputs"] as const) {
    optional(source[key], "number", key);
    if (source[key] !== undefined && (!Number.isInteger(source[key]) || (source[key] as number) < 1)) {
      throw new Error(`${key} must be a positive integer.`);
    }
  }
  if (typeof source.outputs === "number" && source.outputs > 8) throw new Error("outputs cannot exceed 8.");
  optional(source.loopOutputMode, "string", "loopOutputMode");
  if (source.loopOutputMode !== undefined && !LOOP_MODES.has(source.loopOutputMode as string)) {
    throw new Error("loopOutputMode must be \"last\" or \"all\".");
  }
  if (source.workspaceTools !== undefined) {
    if (!object(source.workspaceTools) || Object.values(source.workspaceTools).some((value) => typeof value !== "boolean")) {
      throw new Error("workspaceTools must contain only boolean settings.");
    }
  }
  if (source.tools !== undefined) {
    if (!Array.isArray(source.tools)) throw new Error("tools must be an array.");
    const ids = new Set<string>();
    for (const [index, tool] of source.tools.entries()) {
      if (!object(tool) || typeof tool.id !== "string" || typeof tool.label !== "string" ||
          typeof tool.kind !== "string" || !TOOL_KINDS.has(tool.kind)) {
        throw new Error(`tools[${index}] is not a valid tool configuration.`);
      }
      if (ids.has(tool.id)) throw new Error(`tools[${index}] repeats tool id "${tool.id}".`);
      ids.add(tool.id);
      optional(tool.enabled, "boolean", `tools[${index}].enabled`);
      for (const key of ["allowedDomains", "serverUrl", "authorization", "fnName", "fnDescription", "fnParameters", "fnCode"] as const) {
        optional(tool[key], "string", `tools[${index}].${key}`);
      }
      optional(tool.timeoutSec, "number", `tools[${index}].timeoutSec`);
      if (tool.timeoutSec !== undefined && (!Number.isInteger(tool.timeoutSec) || (tool.timeoutSec as number) < 1)) {
        throw new Error(`tools[${index}].timeoutSec must be a positive integer.`);
      }
      if (tool.contextSize !== undefined && !["low", "medium", "high"].includes(tool.contextSize as string)) {
        throw new Error(`tools[${index}].contextSize is not supported.`);
      }
      if (tool.selectedTools !== undefined && (!Array.isArray(tool.selectedTools) ||
          tool.selectedTools.some((value) => typeof value !== "string"))) {
        throw new Error(`tools[${index}].selectedTools must be an array of strings.`);
      }
    }
  }

  const config = inferenceConfiguration(source as unknown as InputData);
  return { ...config, tools: config.tools as ToolConfig[] | undefined };
}
