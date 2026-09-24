import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

type CachedModel = { useGpu?: boolean; model: string; status: string; bytes: number; active: boolean; error?: string; downloaded?: number; total?: number };
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;

export function ModelLibrary({ onChange }: { onChange: () => void }) {
  const [model, setModel] = useState("");
  const [models, setModels] = useState<CachedModel[]>([]);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const signature = useRef("");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let delay = 1000;
      try {
        const response = await fetch("/api/local-model/models", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
        if (!response.ok) throw new Error("Could not load the model library.");
        const body = await response.json();
        if (controller.signal.aborted) return;
        if (!Array.isArray(body.models)) throw new Error("The model library response was invalid. Check that the server is up to date.");
        setModels(body.models); setRuntimeBusy(!!body.activity);
        if (body.models.some((entry: CachedModel) => entry.active)) delay = 500;
        const next = JSON.stringify(body.models.filter((m: CachedModel) => m.status === "Downloaded").map((m: CachedModel) => m.model));
        if (signature.current !== next) { signature.current = next; changed.current(); }
      } catch (err) { if (!controller.signal.aborted) setError((err as Error).message); }
      if (!controller.signal.aborted) timer = setTimeout(poll, delay);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  async function action(kind: "download" | "cancel" | "delete" | "gpu", id: string, useGpu?: boolean) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/local-model/${kind === "delete" ? "models" : kind}`, {
        method: kind === "delete" ? "DELETE" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: id, ...(kind === "gpu" ? { useGpu } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Model action failed.");
      if (kind === "download") { setModels((current) => [...current.filter((m) => m.model !== id), { model: id, status: "Queued", active: true, bytes: 0 }]); setModel(""); }
      if (kind === "gpu") setModels((current) => current.map((entry) => entry.model === id ? { ...entry, useGpu } : entry));
      if (kind === "delete") { setModels((current) => current.filter((m) => m.model !== id)); changed.current(); }
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="model-library" aria-label="Downloaded models">
    <form className="model-download-form" onSubmit={(e) => { e.preventDefault(); void action("download", model.trim()); }}>
      <label className="stack">Hugging Face model ID
        <input className="line" value={model} onChange={(e) => setModel(e.target.value)} placeholder="organization/model-name" />
      </label>
      <button className="icon model-download" disabled={busy || !model.trim()} type="submit" title="Download model" aria-label="Download"><Icon name="download" size={13} /></button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    {!models.length && <p className="dim">No local models downloaded yet.</p>}
    {models.map((entry) => <div className="model-library-entry" key={entry.model}>
      <strong>{entry.model}</strong>
      <span className="dim">{entry.status}{!entry.active && entry.bytes > 0 ? ` · ${size(entry.bytes)} cached` : ""}</span>
      {entry.active && <>
        <progress aria-label={`Downloading ${entry.model}`} max={entry.total && entry.total > 0 ? entry.total : undefined}
          value={entry.total && entry.total > 0 ? entry.downloaded ?? 0 : undefined} />
        {!!entry.total && <span className="dim">{size(entry.downloaded ?? 0)} / {size(entry.total)}</span>}
      </>}
      {entry.status === "Downloaded" && !entry.active && <label className="sandbox-row">
        <span className="skip sandbox"><input type="checkbox" checked={!!entry.useGpu}
          disabled={busy} onChange={(e) => void action("gpu", entry.model, e.target.checked)} />
          <span className="track" aria-hidden="true" /></span>
        <span>Use GPU</span>
      </label>}
      {entry.error && <p className="error">{entry.error}</p>}
      <div className="settings-actions">
        {entry.active ? <button className="icon tinted tint-err" title="Cancel download" aria-label="Cancel download" disabled={busy || entry.status === "Cancelling"} onClick={() => void action("cancel", entry.model)}><Icon name="stop" size={13} /></button>
          : <>
            {entry.status !== "Downloaded" && <button className="icon model-download" disabled={busy} title="Download or retry model" aria-label="Download / Retry" onClick={() => void action("download", entry.model)}><Icon name="download" size={13} /></button>}
            <button className="icon tinted tint-err" aria-label="Delete" disabled={busy || runtimeBusy || models.some((m) => m.active)}
              title={runtimeBusy ? "Wait for local runs and downloads to finish before deleting" : "Delete this model's cached files"}
              onClick={() => void action("delete", entry.model)}><Icon name="trash" size={13} /></button>
          </>}
      </div>
    </div>)}
  </section>;
}
