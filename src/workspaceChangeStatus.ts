import { useEffect, useSyncExternalStore } from "react";

const counts = new Map<string, number>();
const versions = new Map<string, number>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Share authoritative acceptance updates between the review panel and every linked output. */
export function publishWorkspaceChanges(review: { id: string; changes: { accepted: boolean }[] }) {
  versions.set(review.id, (versions.get(review.id) ?? 0) + 1);
  counts.set(review.id, review.changes.filter((change) => !change.accepted).length);
  listeners.forEach((listener) => listener());
}

function refresh(id: string) {
  if (pending.has(id)) return;
  const version = versions.get(id) ?? 0;
  const request = fetch(`/api/workspace-changes/${encodeURIComponent(id)}/summary`).then(async (response) => {
    if (!response.ok) return;
    const result = await response.json();
    if ((versions.get(id) ?? 0) !== version || !Number.isInteger(result.pending) || result.pending < 0) return;
    counts.set(id, result.pending);
    listeners.forEach((listener) => listener());
  }).catch(() => { /* Keep review accessible when the summary is temporarily unavailable. */ })
    .finally(() => pending.delete(id));
  pending.set(id, request);
}

export function usePendingWorkspaceChanges(id?: string) {
  const count = useSyncExternalStore(subscribe, () => id ? counts.get(id) : undefined);
  useEffect(() => {
    if (!id) return;
    const update = () => refresh(id);
    update();
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, [id]);
  return count;
}
