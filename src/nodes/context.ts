import { createContext, useContext } from "react";
import type { InputData, OutputData } from "../types";

export type GraphActions = {
  providerModels: Partial<Record<import("../api").Provider, string[]>>;
  providerSettings: import("../api").PlatformSettings | null;
  defaultProvider: import("../api").Provider;
  /** The step Next would run, highlighted on the canvas. */
  currentId: string | null;
  /** A function patch is resolved against the node's current data, so an edit made after an
   * await cannot write back a stale copy. */
  updateInput: (
    id: string,
    patch: Partial<InputData> | ((data: InputData) => Partial<InputData>),
  ) => void;
  updateOutput: (id: string, patch: Partial<OutputData>) => void;
  setSkipped: (id: string, value: boolean) => void;
  runOne: (id: string) => void;
  removeNode: (id: string) => void;
};

export const GraphActionsContext = createContext<GraphActions | null>(null);

export function useGraphActions(): GraphActions {
  const ctx = useContext(GraphActionsContext);
  if (!ctx) throw new Error("useGraphActions must be used inside GraphActionsContext");
  return ctx;
}
