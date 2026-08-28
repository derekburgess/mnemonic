import { useCallback, useState } from "react";

/**
 * Keeps every resizable field in a node the same width.
 *
 * A field is never given a fixed width: the browser writes one on whichever element you drag,
 * and that element is handed straight back to CSS (`width: 100%`). What survives the gesture is
 * a *minimum* applied to every field in the node, which grows the node without capping it — so
 * all the fields stretch to whatever width the node settles at and stay flush with each other.
 *
 * `offset` accounts for chrome beside the field, such as the tool-call name column.
 */
export function useFieldWidth() {
  const [min, setMin] = useState<number | null>(null);

  const onResized = useCallback(
    (offset = 0) =>
      (event: React.PointerEvent<HTMLElement>) => {
        const el = event.currentTarget;
        const dragged = el.style.width;
        if (!dragged) return;
        el.style.width = "";
        setMin(Math.round(parseFloat(dragged) + offset));
      },
    [],
  );

  /** Spread onto a full-width field. */
  const field = (offset = 0) => ({
    style: min ? { minWidth: min } : undefined,
    onPointerUp: onResized(offset),
  });

  return { min, field };
}
