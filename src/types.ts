import type { Node, Edge } from "@xyflow/react";

export type Effort = "off" | "minimal" | "low" | "medium" | "high";

export type NodeStatus = "idle" | "running" | "done" | "error";

export type InputData = {
  /** When false, this node contributes context and resources downstream without invoking a model. */
  performInference?: boolean;
  provider?: import("./api").Provider;
  label: string;
  model: string;
  effort: Effort;
  /** Folded into the system prompt ahead of the instructions. */
  role?: string;
  instructions?: string;
  /** Run this step inside an ephemeral container instead of in the proxy's own process. */
  sandbox?: boolean;
  /** Saved JSON used only on the next explicit run. */
  sandboxConfig?: string;
  sandboxPanel?: { draft?: string; provider?: import("./api").Provider; model?: string; instructions?: string; recommendation?: string; error?: string };
  useGpu?: boolean;
  /** Folders on this machine the step lends the model, reachable with the workspace tools. */
  workspaces?: Workspace[];
  /** Markdown documents appended to the system prompt, after the instructions. */
  attachments?: Attachment[];
  /** Files sent with the input: PDFs and images natively, text inlined. */
  files?: InputFile[];
  /** URLs fetched at run time and sent with the input. */
  links?: { id: string; url: string }[];
  prompt: string;
  /** Capabilities this step may call. */
  tools?: ToolConfig[];
  workspaceTools?: import("./toolSettings").WorkspaceToolSettings;
  /** How many times the model may come back asking for more tools before the run gives up. */
  maxRounds?: number;
  /** Repeat explicit node runs until stopped; each iteration preserves its outputs. */
  loop?: boolean;
  /** Budget for the whole step: every round plus the tools they call. Seconds. */
  timeoutSec?: number;
  /** How many artifacts one run of this step generates. */
  outputs: number;
  /** Kept in the graph and wired, but never executed. */
  skipped?: boolean;
  /** Trace identity only; live status is read from the existing execution events. */
  lastExecution?: import("./executionStatus").NodeExecution;
  status: NodeStatus;
  error?: string;
};

/**
 * A folder on this machine, held as an absolute path. The browser cannot report a real path
 * for a folder you pick, so the path comes from the proxy's own picker — or is simply typed.
 */
export type Workspace = { id: string; path: string };

/** A markdown file attached to a step, carried into its system prompt as standing guidance. */
export type Attachment = { id: string; name: string; text: string };

/** A document or image attached to a step, sent as content alongside its input. */
export type InputFile = { id: string; name: string; mime: string; dataUrl: string };

export type ToolKind = "web_search" | "mcp" | "custom";

/** A tool belongs to the step that may call it. Flat across kinds so edits stay simple. */
export type ToolConfig = {
  id: string;
  label: string;
  kind: ToolKind;
  enabled?: boolean;
  /** web_search */
  contextSize?: "low" | "medium" | "high";
  allowedDomains?: string;
  /** mcp */
  serverUrl?: string;
  authorization?: string;
  selectedTools?: string[];
  /** How long one invocation of this tool may take. Seconds. */
  timeoutSec?: number;
  /** custom */
  fnName?: string;
  fnDescription?: string;
  fnParameters?: string;
  fnCode?: string;
};

/** What a step actually invoked during a run, recorded on the artifact it produced. */
export type ToolCallRecord = { name: string; detail?: string; urls?: string[] };

export type OutputData = {
  kind?: "thinking";
  workspaceChanges?: string;
  execId?: string;
  runId?: string;
  /** Which input node produced this artifact. Outputs are immutable records of one run. */
  sourceId: string;
  sourceLabel: string;
  model: string;
  effort: Effort;
  text: string;
  createdAt: number;
  usage?: { input?: number; output?: number };
  /** Kept in the graph and wired, but withheld from downstream context. */
  skipped?: boolean;
  toolCalls?: ToolCallRecord[];
  /** Set once the text has been changed by hand, so the node stops claiming to be verbatim. */
  edited?: boolean;
};

// "input", "output", "default" and "group" are React Flow's own built-in node types; using
// those keys would apply its default node chrome (white box, fixed width) underneath ours.
export type InputNode = Node<InputData, "step">;
export type OutputNode = Node<OutputData, "artifact">;
export type GraphNode = InputNode | OutputNode;
export type GraphEdge = Edge;

export const isInput = (n: GraphNode): n is InputNode => n.type === "step";
export const isOutput = (n: GraphNode): n is OutputNode => n.type === "artifact";
