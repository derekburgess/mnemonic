import { useEffect, useState } from "react";
import { ResizablePanel } from "./ResizablePanel";
import { publishWorkspaceChanges } from "./workspaceChangeStatus";
import { Icon } from "./icons";

type Preview = { bytes: number; text: string | null; binary: boolean; truncated: boolean } | null;
type Change = { id: string; workspace: string; path: string; kind: string; accepted: boolean; conflict?: string; before: Preview; after: Preview };
type Review = { id: string; changes: Change[] };

function FilePreview({ label, file }: { label: string; file: Preview }) {
  return <div className="stack"><strong>{label}</strong>
    {!file ? <span className="dim">File does not exist</span> : file.binary ?
      <span className="dim">Binary file · {file.bytes.toLocaleString()} bytes</span> :
      <><pre className="workspace-preview nowheel">{file.text || "(empty file)"}</pre>
      {file.truncated && <span className="dim">Preview truncated · {file.bytes.toLocaleString()} bytes total</span>}</>}
  </div>;
}

export function WorkspaceChangesPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [review, setReview] = useState<Review | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = `/api/workspace-changes/${encodeURIComponent(id)}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal }).then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load workspace changes.");
      setReview(body); publishWorkspaceChanges(body);
      setSelected(body.changes.filter((c: Change) => !c.accepted && !c.conflict).map((c: Change) => c.id));
    }).catch((err) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [url]);

  async function accept() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`${url}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: selected }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not apply workspace changes.");
      setReview(body); publishWorkspaceChanges(body); setSelected([]);
    } catch (err) {
      setError((err as Error).message);
      // Reconcile conflicts and any files applied before an I/O failure.
      try {
        const res = await fetch(url);
        if (res.ok) { const body: Review = await res.json(); setReview(body); publishWorkspaceChanges(body);
          setSelected((keys) => keys.filter((key) => body.changes.some((c) => c.id === key && !c.accepted && !c.conflict))); }
      } catch { /* Keep the original acceptance error. */ }
    } finally { setBusy(false); }
  }

  const allAccepted = !!review && review.changes.every((change) => change.accepted);

  return <ResizablePanel storageKey="mnemonic.workspace-changes.width" defaultWidth={560}
    className="trace-panel sandbox-panel" label="Workspace changes" resizeLabel="Resize workspace changes panel">
    <header className="trace-head"><strong>Workspace changes</strong><div className="spacer" />
      <button className="tinted tint-err" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
    </header>
    <div className="trace-list">
      {error && <p className="error" role="alert">{error}</p>}
      {!review && !error && <span className="dim">Loading changes…</span>}
      {review && <>
        <button className="workspace-accept tinted tint-ok" onClick={accept} disabled={busy || allAccepted || !selected.length}>{allAccepted ? "All changes accepted." : busy ? "Applying…" : `Accept${selected.length ? ` (${selected.length})` : ""}`}</button>
        {review.changes.map((change) => <section className="workspace-change" key={change.id}>
          <div className="workspace-change-heading">{!change.accepted && <input type="checkbox" checked={selected.includes(change.id)}
            aria-label={`Accept ${change.workspace}/${change.path}`}
            disabled={busy || !!change.conflict} onChange={(e) => setSelected((keys) => e.target.checked ? [...keys, change.id] : keys.filter((key) => key !== change.id))} />}
            <button className="workspace-file-toggle" aria-expanded={expanded.includes(change.id)}
              aria-controls={`workspace-file-${id}-${change.id}`}
              onClick={() => setExpanded((keys) => keys.includes(change.id) ? keys.filter((key) => key !== change.id) : [...keys, change.id])}>
              <span className={`caret${expanded.includes(change.id) ? " open" : ""}`} aria-hidden="true">›</span>
              <strong>{change.workspace}/{change.path}</strong>
            </button>
            <span className="dim">{change.accepted ? "Accepted" : change.kind}</span>
          </div>
          {change.conflict && <p className="error">{change.conflict}</p>}
          <div id={`workspace-file-${id}-${change.id}`} hidden={!expanded.includes(change.id)}>
            <div className="workspace-versions">
            <FilePreview label="Current" file={change.before} />
            <FilePreview label="Proposed" file={change.after} />
            </div>
          </div>
        </section>)}
      </>}
    </div>
  </ResizablePanel>;
}
