import type { Node, Edge } from "@xyflow/react";

export type Effort = "off" | "minimal" | "low" | "medium" | "high";

export type NodeStatus = "idle" | "running" | "done" | "error";

export type InputData = {
  label: string;
  model: string;
  effort: Effort;
  /** Folded into the system prompt ahead of the instructions. */
  role?: string;
  instructions?: string;
  prompt: string;
  /** How many artifacts one run of this step generates. */
  outputs: number;
  /** Kept in the graph and wired, but never executed. */
  skipped?: boolean;
  status: NodeStatus;
  error?: string;
};

export type OutputData = {
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
};

// "input", "output", "default" and "group" are React Flow's own built-in node types; using
// those keys would apply its default node chrome (white box, fixed width) underneath ours.
export type InputNode = Node<InputData, "step">;
export type OutputNode = Node<OutputData, "artifact">;
export type GraphNode = InputNode | OutputNode;
export type GraphEdge = Edge;

export const isInput = (n: GraphNode): n is InputNode => n.type === "step";
export const isOutput = (n: GraphNode): n is OutputNode => n.type === "artifact";
