export const DEFAULT_LOOP_LIMIT = 3;
export const MAX_LOOP_LIMIT = 100;

export const normalizeLoopLimit = (value: number | undefined) =>
  Math.min(MAX_LOOP_LIMIT, Math.max(1, Math.floor(value || DEFAULT_LOOP_LIMIT)));
