import { createContext, useContext } from "react";
import type { InputData } from "../types";

export type GraphActions = {
  models: string[];
  updateInput: (id: string, patch: Partial<InputData>) => void;
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
