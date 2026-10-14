import type { Node, Edge } from "@xyflow/react";

export type Effort = "off" | "minimal" | "low" | "medium" | "high";

export type NodeStatus = "idle" | "running" | "done" | "error";
export type LoopOutputMode = "last" | "all";

export type InputData = {
  /** Whether the node is shown as only its title and primary actions. */
  collapsed?: boolean;
  /** Legacy graph field. Context-only steps are migrated to explicit Context nodes. */
  performInference?: boolean;
  provider?: import("./api").Provider;
  label: string;
  model: string;
  effort: Effort;
  /** Legacy context fields retained only so older graph exports can be migrated. */
  role?: string;
  instructions?: string;
  /** Run this step inside an ephemeral container instead of in the proxy's own process. */
  sandbox?: boolean;
  /** Saved JSON used only on the next explicit run. */
  sandboxConfig?: string;
  sandboxPanel?: { draft?: string; provider?: import("./api").Provider; model?: string; instructions?: string; recommendation?: string; error?: string };
  useGpu?: boolean;
  /** Legacy context resources retained only so older graph exports can be migrated. */
  workspaces?: Workspace[];
  /** Markdown documents appended to the system prompt, after the instructions. */
  attachments?: Attachment[];
  /** Files sent with the input: PDFs and images natively, text inlined. */
  files?: InputFile[];
  /** URLs fetched at run time and sent with the input. */
  links?: { id: string; url: string }[];
  prompt?: string;
  /** Capabilities this step may call. */
  tools?: ToolConfig[];
  workspaceTools?: import("./toolSettings").WorkspaceToolSettings;
  /** How many times the model may come back asking for more tools before the run gives up. */
  maxRounds?: number;
  /** Repeat explicit node runs until stopped; each iteration preserves its outputs. */
  loop?: boolean;
  /** Maximum iterations for one loop start. */
  loopLimit?: number;
  /** Whether downstream routes advance to the latest iteration or accumulate every iteration. */
  loopOutputMode?: LoopOutputMode;
  /** Budget for the whole step: every round plus the tools they call. Seconds. */
  timeoutSec?: number;
  /** How many artifacts one run of this step generates. */
  outputs: number;
  /** Trace identity only; live status is read from the existing execution events. */
  lastExecution?: import("./executionStatus").NodeExecution;
  status: NodeStatus;
  error?: string;
};

export type ContextData = {
  collapsed?: boolean;
  label: string;
  /** Folded into the system prompt ahead of the instructions. */
  role?: string;
  instructions?: string;
  prompt: string;
  /** Folders lent to every connected inference node. */
  workspaces?: Workspace[];
  /** Markdown documents appended to the system prompt. */
  attachments?: Attachment[];
  /** Files sent with the input alongside the composed text. */
  files?: InputFile[];
  /** URLs fetched when a connected inference runs. */
  links?: { id: string; url: string }[];
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
  /** Placement identity for one fan-out result set; shared by its thinking and answer cards. */
  outputSetId?: string;
  /** Stable macro-cluster position among the source step's historical result sets. */
  outputSetIndex?: number;
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
  /** Hide the main output text and tool-call details while retaining compact metadata. */
  collapsed?: boolean;
  toolCalls?: ToolCallRecord[];
  /** Set once the text has been changed by hand, so the node stops claiming to be verbatim. */
  edited?: boolean;
};

export type CommentReply = {
  id: string;
  author: string;
  text: string;
  createdAt: number;
  collapsed?: boolean;
};

export type CommentData = {
  /** Person associated with this note and used as its downstream context label. */
  author: string;
  text: string;
  createdAt: number;
  collapsed?: boolean;
  /** Ordered human responses carried downstream immediately after the original note. */
  replies?: CommentReply[];
};

// "input", "output", "default" and "group" are React Flow's own built-in node types; using
// those keys would apply its default node chrome (white box, fixed width) underneath ours.
export type InputNode = Node<InputData, "step">;
export type ContextNode = Node<ContextData, "context">;
export type OutputNode = Node<OutputData, "artifact">;
export type CommentNode = Node<CommentData, "comment">;
export type GraphNode = InputNode | ContextNode | OutputNode | CommentNode;
export type GraphEdgeData = {
  /** Legacy midpoint retained for graphs saved before segment controls were introduced. */
  control?: { x: number; y: number };
  /** Editable coordinates for the orthogonal route's movable interior segments. */
  route?: {
    mode?: "dogleg";
    centerX?: number;
    centerY?: number;
    sourceLaneX?: number;
    targetLaneX?: number;
    waypoints?: Array<{ x: number; y: number }>;
  };
};
export type GraphEdge = Edge<GraphEdgeData>;

export const isInput = (n: GraphNode): n is InputNode => n.type === "step";
export const isContext = (n: GraphNode): n is ContextNode => n.type === "context";
export const isOutput = (n: GraphNode): n is OutputNode => n.type === "artifact";
export const isComment = (n: GraphNode): n is CommentNode => n.type === "comment";
