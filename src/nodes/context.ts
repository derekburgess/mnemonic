import { createContext, useContext } from "react";
import type { CommentData, ContextData, GraphEdgeData, InputData, OutputData, WorkspaceFileData } from "../types";

export type GraphActions = {
  openWorkspaceChanges: (id: string) => void;
  openSandboxConfig: (id: string) => void;
  providerModels: Partial<Record<import("../api").Provider, string[]>>;
  providerSettings: import("../api").PlatformSettings | null;
  defaultProvider: import("../api").Provider;
  /** The step Next would run, highlighted on the canvas. */
  currentId: string | null;
  /** Number of connected, non-empty workspaces available to each inference. */
  workspaceCounts: Record<string, number>;
  /** A function patch is resolved against the node's current data, so an edit made after an
   * await cannot write back a stale copy. */
  updateInput: (
    id: string,
    patch: Partial<InputData> | ((data: InputData) => Partial<InputData>),
  ) => void;
  updateContext: (
    id: string,
    patch: Partial<ContextData> | ((data: ContextData) => Partial<ContextData>),
  ) => void;
  updateOutput: (id: string, patch: Partial<OutputData>) => void;
  updateComment: (
    id: string,
    patch: Partial<CommentData> | ((data: CommentData) => Partial<CommentData>),
  ) => void;
  updateWorkspaceFile: (id: string, patch: Partial<WorkspaceFileData>) => void;
  openWorkspaceFile: (outputId: string, href: string) => void;
  updateEdgeRoute: (id: string, route?: Partial<NonNullable<GraphEdgeData["route"]>>) => void;
  runOne: (id: string) => void;
  stopNode: (id: string) => void;
  activeNodeIds: string[];
  removeNode: (id: string) => void;
};

export const GraphActionsContext = createContext<GraphActions | null>(null);

export function useGraphActions(): GraphActions {
  const ctx = useContext(GraphActionsContext);
  if (!ctx) throw new Error("useGraphActions must be used inside GraphActionsContext");
  return ctx;
}
