/** Stable identity used when upgrading the single canvas that predates canvas-scoped traces. */
export const LEGACY_CANVAS_ID = "legacy-current";

export function newCanvasId(): string {
  return crypto.randomUUID();
}

export function validCanvasId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}
