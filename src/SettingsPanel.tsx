import { ResizablePanel } from "./ResizablePanel";
import { ModelLibrary } from "./ModelLibrary";
import { useCallback, useEffect, useState } from "react";
import { fetchSettings, saveSettings, type PlatformSettings, type Provider } from "./api";
import { Icon } from "./icons";

type SettingsPanelProps = { onClose: () => void; onSaved: (settings: PlatformSettings) => void };
const PROVIDERS: { provider: Provider; label: string }[] = [
  { provider: "openai", label: "OpenAI" },
  { provider: "compatible", label: "OpenAI-compatible" },
  { provider: "huggingface", label: "Hugging Face" },
];

export function SettingsPanel({ onClose, onSaved }: SettingsPanelProps) {
  return <ResizablePanel className="side-panel" storageKey="mnemonic.settings.width" defaultWidth={360}
    label="Settings" resizeLabel="Resize settings panel">
    <header className="trace-head">
      <strong>Settings</strong><div className="spacer" />
      <button className="tinted tint-err" onClick={onClose} title="Close" aria-label="Close"><Icon name="close" /></button>
    </header>
    <div className="trace-list">
      {PROVIDERS.map(({ provider, label }) => <ProviderSettingsSection key={provider} provider={provider} label={label} onSaved={onSaved} />)}
    </div>
  </ResizablePanel>;
}

function ProviderSettingsSection({ provider, label, onSaved }: {
  provider: Provider; label: string; onSaved: SettingsPanelProps["onSaved"];
}) {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState<"key" | "baseUrl" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchSettings(provider)
      .then((s) => {
        setSettings(s);
        setBaseUrl(s.baseUrl || (s.provider === "openai" ? "https://api.openai.com/v1" : ""));
      })
      .catch((err) => setError((err as Error).message));
  }, [provider]);

  const save = useCallback(
    async (patch: { runLocally?: boolean; apiKey?: string; baseUrl?: string; provider?: Provider }) => {
      setBusy(true);
      setError(null);
      setStatus(null);
      try {
        const next = await saveSettings({ ...patch, provider });
        setSettings(next);
        if (patch.baseUrl !== undefined) setBaseUrl(next.baseUrl || (provider === "openai" ? "https://api.openai.com/v1" : ""));
        if (patch.apiKey !== undefined) setApiKey("");
        setStatus(patch.apiKey ? "key" : patch.baseUrl !== undefined ? "baseUrl" : null);
        onSaved(next);
        setTimeout(() => setStatus(null), 1600);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [onSaved, provider],
  );

  return (
    <details className="provider-settings">
      <summary>{label}</summary>
      <section aria-label={`${label} settings`}>
        {error && <p className="error" role="alert">{error}</p>}
        <fieldset className="provider-settings-fields" disabled={busy || !settings}>
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

        {provider === "huggingface" && (
          <label className="sandbox-row">
            <span className="skip sandbox"><input type="checkbox" checked={!!settings?.runLocally}
              disabled={busy} onChange={(e) => save({ runLocally: e.target.checked })} />
              <span className="track" aria-hidden="true" /></span>
            <span>Download and run models locally</span>
          </label>
        )}

        {provider === "huggingface" && settings?.runLocally && <ModelLibrary onChange={() => onSaved(settings)} />}

        {!settings?.runLocally || provider !== "huggingface" ? <>
        <label className="stack">
          Base URL
          <input
            className="line"
            placeholder={provider === "huggingface" ? "http://localhost:8000/v1" : "https://api.openai.com/v1"}
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

        </fieldset>
      </section>
    </details>
  );
}
