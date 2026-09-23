import { useCallback, useEffect, useState } from "react";
import { fetchSettings, saveSettings, type PlatformSettings, type Provider } from "./api";
import { Icon } from "./icons";

const SOURCE_LABEL: Record<PlatformSettings["keySource"], string> = {
  panel: "set here",
  env: "from .env",
  none: "not set",
};

export function SettingsPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchSettings()
      .then((s) => {
        setSettings(s);
        setBaseUrl(s.baseUrl);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  const save = useCallback(
    async (patch: { apiKey?: string; baseUrl?: string; provider?: Provider }) => {
      setBusy(true);
      setError(null);
      try {
        const next = await saveSettings(patch);
        setSettings(next);
        setBaseUrl(next.baseUrl);
        setApiKey("");
        setStatus("Saved");
        onSaved();
        setTimeout(() => setStatus(null), 1600);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [onSaved],
  );

  return (
    <aside className="side-panel">
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
          Provider
          <select
            value={settings?.provider ?? "openai"}
            onChange={(e) => save({ provider: e.target.value as Provider })}
            disabled={busy || !settings}
          >
            <option value="openai">OpenAI — Responses API</option>
            <option value="huggingface">Hugging Face — Local models</option>
            <option value="compatible">OpenAI-compatible — Chat Completions</option>
          </select>
        </label>

        <p className="settings-note">
          {settings?.provider === "huggingface"
            ? "Connect to a running local model server such as vLLM, TGI or llama.cpp using its Chat Completions endpoint. Models are loaded by that server. Tool and image support depend on the model and server."
            : settings?.provider === "compatible"
            ? "Works with OpenRouter, vLLM, Ollama, LM Studio and anything else speaking /v1/chat/completions. MCP and custom tools work here; the built-in web search tool does not."
            : "OpenAI's own API. Adds the built-in web search tool and records the model's reasoning items in the trace."}
        </p>

        <label className="stack">
          API key {settings?.provider === "huggingface" && <span className="dim">(optional)</span>} {settings && <span className="dim">({SOURCE_LABEL[settings.keySource]})</span>}
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
            Save key
          </button>
          {settings?.hasPanelKey && (
            <button className="tinted tint-err" disabled={busy} onClick={() => save({ apiKey: "" })}>
              <Icon name="trash" /> Clear
            </button>
          )}
          {status && <span className="dim">{status}</span>}
        </div>

        <label className="stack">
          Base URL <span className="dim">{settings?.provider === "huggingface" ? "(include /v1)" : "(blank for OpenAI)"}</span>
          <input
            className="line"
            placeholder={settings?.provider === "huggingface" ? "http://localhost:8000/v1" : "https://api.openai.com/v1"}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>

        <div className="settings-actions">
          <button className="tinted tint-ok" disabled={busy} onClick={() => save({ baseUrl })}>
            Save base URL
          </button>
        </div>

        <p className="settings-note">
          {settings?.provider === "huggingface" ? (
            <>Leave the key empty for an unauthenticated local server. These settings are separate from your cloud credentials. Sandbox runs route localhost through host.docker.internal. The model server must listen on an interface reachable from Docker.</>
          ) : <>The key is stored in <code>data/settings.json</code> on this machine and is never sent to
          the browser — only whether one is set. A key here takes precedence over{" "}
          <code>OPENAI_API_KEY</code> in <code>.env</code>.</>}
        </p>
      </div>
    </aside>
  );
}
