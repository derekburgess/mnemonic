import { ResizablePanel } from "./ResizablePanel";
import { ModelLibrary } from "./ModelLibrary";
import { useCallback, useEffect, useState } from "react";
import { fetchSettings, saveSettings, type PlatformSettings, type Provider } from "./api";
import { Icon } from "./icons";

export function SettingsPanel({ onClose, onSaved }: { onClose: () => void; onSaved: (settings: PlatformSettings) => void }) {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState<"key" | "baseUrl" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchSettings()
      .then((s) => {
        setSettings(s);
        setBaseUrl(s.baseUrl || (s.provider === "openai" ? "https://api.openai.com/v1" : ""));
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  const save = useCallback(
    async (patch: { runLocally?: boolean; apiKey?: string; baseUrl?: string; provider?: Provider }) => {
      setBusy(true);
      setError(null);
      setStatus(null);
      try {
        const next = await saveSettings({ ...patch, provider: settings?.provider });
        setSettings(next);
        setBaseUrl(next.baseUrl || (next.provider === "openai" ? "https://api.openai.com/v1" : ""));
        setApiKey("");
        setStatus(patch.apiKey ? "key" : patch.baseUrl !== undefined ? "baseUrl" : null);
        onSaved(next);
        setTimeout(() => setStatus(null), 1600);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [onSaved, settings?.provider],
  );

  return (
    <ResizablePanel className="side-panel" storageKey="mnemonic.settings.width" defaultWidth={360}
      label="Settings" resizeLabel="Resize settings panel">
      <header className="trace-head">
        <strong>Settings</strong>
        <div className="spacer" />
        <button className="tinted tint-err" onClick={onClose} title="Close" aria-label="Close">
          <Icon name="close" />
        </button>
      </header>

      <div className="trace-list">
        {error && <p className="error">{error}</p>}

        <label className="stack">
          Configure provider
          <select
            value={settings?.provider ?? "openai"}
            onChange={(e) => {
              setBusy(true);
              setApiKey("");
              setStatus(null);
              setError(null);
              void fetchSettings(e.target.value as Provider)
                .then((next) => { setSettings(next); setBaseUrl(next.baseUrl); })
                .catch((err) => setError(err.message))
                .finally(() => setBusy(false));
            }}
            disabled={busy || !settings}
          >
            <option value="openai">OpenAI — Responses API</option>
            <option value="compatible">OpenAI-compatible — Chat Completions</option>
            <option value="huggingface">Hugging Face</option>
          </select>
        </label>

        <label className="stack">
          API key
          <input
            className="line"
            type="password"
            autoComplete="off"
            placeholder={settings?.keySource === "none" ? "" : "•••••••• — enter a new key to replace"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>

        <div className="settings-actions">
          <button
            className="tinted tint-ok"
            disabled={busy || !apiKey.trim()}
            onClick={() => save({ apiKey: apiKey.trim() })}
          >
            <Icon name="gear" /> {status === "key" ? "Saved" : "Set Key"}
          </button>
          <button className="tinted tint-err" disabled={busy || !settings?.hasPanelKey} onClick={() => save({ apiKey: "" })}>
            <Icon name="trash" /> Clear
          </button>
        </div>

        {settings?.provider === "huggingface" && (
          <label className="sandbox-row">
            <span className="skip sandbox"><input type="checkbox" checked={!!settings.runLocally}
              disabled={busy} onChange={(e) => save({ runLocally: e.target.checked })} />
              <span className="track" aria-hidden="true" /></span>
            <span>Download and run models locally</span>
          </label>
        )}

        {settings?.provider === "huggingface" && settings.runLocally && <ModelLibrary onChange={() => onSaved(settings)} />}

        {!settings?.runLocally || settings.provider !== "huggingface" ? <>
        <label className="stack">
          Base URL
          <input
            className="line"
            placeholder={settings?.provider === "huggingface" ? "http://localhost:8000/v1" : "https://api.openai.com/v1"}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>

        <div className="settings-actions">
          <button className="tinted tint-ok" disabled={busy} onClick={() => save({ baseUrl })}>
            <Icon name="gear" /> {status === "baseUrl" ? "Saved" : "Set Base URL"}
          </button>
        </div>
        </> : null}

      </div>
    </ResizablePanel>
  );
}
