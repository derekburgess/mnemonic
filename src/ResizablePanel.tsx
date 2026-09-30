import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from "react";

const bounds = () => ({ min: Math.min(320, window.innerWidth), max: Math.min(window.innerWidth, Math.max(320, window.innerWidth - 280)) });
const clamp = (width: number) => Math.min(bounds().max, Math.max(bounds().min, width));

/** Shared left-edge resizing for every panel docked beside the canvas. */
export function ResizablePanel({ storageKey, defaultWidth, label, resizeLabel, className, children }: {
  storageKey: string; defaultWidth: number; label: string; resizeLabel: string; className: string; children: ReactNode;
}) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return clamp(Number.isFinite(saved) && saved >= 320 ? saved : defaultWidth);
    } catch { return clamp(defaultWidth); }
  });
  const currentWidth = useRef(width);
  const cleanup = useRef<(() => void) | null>(null);
  const persist = () => {
    try { localStorage.setItem(storageKey, String(currentWidth.current)); } catch { /* Storage may be disabled. */ }
  };
  const resize = (next: number) => {
    currentWidth.current = clamp(next);
    setWidth(currentWidth.current);
  };
  useEffect(() => {
    const fit = () => resize(currentWidth.current);
    window.addEventListener("resize", fit);
    return () => { window.removeEventListener("resize", fit); cleanup.current?.(); };
  }, []);

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanup.current?.();
    const move = (e: globalThis.PointerEvent) => resize(window.innerWidth - e.clientX);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      document.body.classList.remove("resizing-col");
      cleanup.current = null;
      persist();
    };
    cleanup.current = stop;
    document.body.classList.add("resizing-col");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }

  return <aside className={className} style={{ width }} aria-label={label}>
    <div className="trace-grip" role="separator" aria-orientation="vertical" aria-label={resizeLabel}
      tabIndex={0} aria-valuemin={bounds().min} aria-valuemax={bounds().max} aria-valuenow={width}
      onPointerDown={startResize} onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault(); resize(currentWidth.current + (event.key === "ArrowLeft" ? 20 : -20)); persist();
      }} />
    {children}
  </aside>;
}
