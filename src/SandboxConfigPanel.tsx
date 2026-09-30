import { ResizablePanel } from "./ResizablePanel";
import { useSyncExternalStore } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { InputNode } from "./types";
import type { Provider } from "./api";
import { defaultSandboxText } from "./sandboxConfig";
import { useGraphActions } from "./nodes/context";
import { Icon } from "./icons";

const pending = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const changed = () => listeners.forEach((listener) => listener());

export function SandboxConfigPanel({ node, onClose }: { node: InputNode; onClose: () => void }) {
  const { updateInput, providerModels } = useGraphActions();
  const state = node.data.sandboxPanel ?? {};
  const draft = state.draft ?? node.data.sandboxConfig ?? defaultSandboxText;
  const provider = state.provider ?? "openai";
  const model = state.model ?? "chat-latest";
  const models = [...new Set([model, ...(providerModels[provider] ?? [])])].filter(Boolean);
  const busy = useSyncExternalStore(subscribe, () => pending.has(node.id));
  const patch = (values: Partial<NonNullable<typeof node.data.sandboxPanel>>) => updateInput(node.id,
    (data) => ({ sandboxPanel: { ...data.sandboxPanel, ...values } }));
  let parseError = "";
  try { JSON.parse(draft); } catch (err) { parseError = (err as Error).message; }

  async function generate() {
    if (pending.has(node.id)) return;
    pending.add(node.id); changed(); patch({ error: undefined });
    try {
      const response = await fetch("/api/sandbox/recommend", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, configuration: draft, instructions: state.instructions ?? "" }),
        signal: AbortSignal.timeout(190_000),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not generate a recommendation.");
      patch({ recommendation: body.text });
    } catch (err) { patch({ error: (err as Error).message }); }
    finally { pending.delete(node.id); changed(); }
  }

  return <ResizablePanel className="side-panel sandbox-config-panel" storageKey="mnemonic.sandbox-config.width" defaultWidth={460}
    label="Sandbox Configuration" resizeLabel="Resize sandbox configuration panel">
    <header className="trace-head">
      <div><strong>Sandbox Configuration</strong><div className="dim">{node.data.label}</div></div>
      <div className="spacer" />
      <button className="tinted tint-err" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
    </header>
    <div className="trace-list">
      <label className="stack">Configuration
        <textarea className="sandbox-config-text" spellCheck={false} value={draft}
          onChange={(e) => patch({ draft: e.target.value })} />
      </label>
      {parseError && <p className="error" role="alert">{parseError}</p>}
      <div className="settings-actions">
        <button className="tinted tint-ok" disabled={!!parseError} onClick={() => {
          try { JSON.parse(draft); updateInput(node.id, { sandboxConfig: draft }); } catch { /* Keep invalid drafts. */ }
        }}>{node.data.sandboxConfig === draft ? "Saved" : "Save"}</button>
        <button onClick={() => patch({ draft: defaultSandboxText })}>Reset to defaults</button>
      </div>
      <div className="sandbox-ai">
        <label className="stack">Provider
          <select value={provider} disabled={busy} onChange={(e) => {
            const next = e.target.value as Provider;
            patch({ provider: next, model: next === "openai" ? "chat-latest" : providerModels[next]?.[0] ?? "" });
          }}>
            <option value="openai">OpenAI</option><option value="compatible">OpenAI-compatible</option><option value="huggingface">Hugging Face</option>
          </select>
        </label>
        <label className="stack">Model
          {models.length ? <select value={model} disabled={busy} onChange={(e) => patch({ model: e.target.value })}>
            {models.map((id) => <option key={id}>{id}</option>)}
          </select> : <input className="line" value={model} disabled={busy} onChange={(e) => patch({ model: e.target.value })} />}
        </label>
        <label className="stack">Instructions
          <textarea value={state.instructions ?? ""} onChange={(e) => patch({ instructions: e.target.value })} />
        </label>
        <button disabled={busy || !model.trim() || !state.instructions?.trim()} onClick={() => void generate()}>
          {busy ? "Generating…" : "Generate an AI recommendation"}
        </button>
        {state.error && <p className="error" role="alert">{state.error}</p>}
        {state.recommendation !== undefined && <div className="stack"><span>Recommendation</span>
          <div className="sandbox-recommendation md" role="region" aria-label="Recommendation" tabIndex={0}>
            <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{state.recommendation}</Markdown>
          </div>
        </div>}
      </div>
    </div>
  </ResizablePanel>;
}
