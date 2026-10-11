/** Keeps a node wired into the graph while taking it out of play. */
export function SkipToggle({ on, onChange, title, accent = false }: { on: boolean; onChange: (v: boolean) => void; title: string; accent?: boolean }) {
  return (
    <label className={`skip nodrag${accent ? " accent" : ""}`} title={title}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
    </label>
  );
}
