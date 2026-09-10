import type { Effort } from "./types";
export type PendingExecution = { runId: string; execId: string; nodeId: string; label: string; effort: Effort; group: string; deadline: number; cancelled?: boolean };
const KEY = "mnemonic.pending.v1";
export function pendingExecutions(): PendingExecution[] {
  try { const value = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
}
export function rememberExecutions(entries: PendingExecution[]) {
  const all = new Map(pendingExecutions().map((e) => [e.execId, e]));
  entries.forEach((entry) => all.set(entry.execId, entry));
  localStorage.setItem(KEY, JSON.stringify([...all.values()]));
}
export function forgetExecutions(ids: string[]) {
  localStorage.setItem(KEY, JSON.stringify(pendingExecutions().filter((e) => !ids.includes(e.execId))));
}
export function cancelPending() {
  const entries = pendingExecutions();
  rememberExecutions(entries.map((entry) => ({ ...entry, cancelled: true })));
  return entries;
}
