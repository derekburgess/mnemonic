import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.cwd(), "data");
const FILE = path.join(DIR, "settings.json");

/** Which API surface to speak. Responses is OpenAI's own; chat is the universal one. */
export type Provider = "openai" | "compatible" | "huggingface";

export type Settings = {
  providers?: Partial<Record<Provider, { apiKey?: string; baseUrl?: string }>>;
  apiKey?: string;
  localApiKey?: string;
  runLocally?: boolean;
  localBaseUrl?: string;
  /** Blank means OpenAI's own endpoint. */
  baseUrl?: string;
  provider?: Provider;
};

let cached: Settings | null = null;

/** A sandbox reaches a host model server through Docker's host gateway. */
export function sandboxModelUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
  }
  return url.toString();
}

export function readSettings(): Settings {
  if (cached) return cached;
  try {
    cached = JSON.parse(readFileSync(FILE, "utf8")) as Settings;
  } catch {
    cached = {};
  }
  return cached;
}

export function writeSettings(next: Settings, selectProvider = true): Settings {
  const current = readSettings();
  const provider = next.provider ?? current.provider ?? "openai";
  const providers = { ...current.providers };
  // Migrate the old shared credentials to their previously selected provider.
  if (!current.providers) {
    providers[current.provider === "compatible" ? "compatible" : "openai"] = { apiKey: current.apiKey, baseUrl: current.baseUrl };
    providers.huggingface = { apiKey: current.localApiKey, baseUrl: current.localBaseUrl };
  }
  providers[provider] = { ...providers[provider],
    ...(next.apiKey !== undefined ? { apiKey: next.apiKey } : {}),
    ...(next.baseUrl !== undefined ? { baseUrl: next.baseUrl } : {}) };
  const merged: Settings = { ...current, ...next, providers, provider: selectProvider ? provider : current.provider ?? "openai" };
  delete merged.apiKey;
  delete merged.baseUrl;
  delete merged.localApiKey;
  delete merged.localBaseUrl;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  cached = merged;
  return merged;
}

/** The key in use, and where it came from. The panel takes precedence over the environment. */
export function resolveCredentials(provider: Provider = readSettings().provider ?? "openai") {
  const settings = readSettings();
  const legacyProvider = settings.provider === "compatible" ? "compatible" : "openai";
  const config = settings.providers?.[provider] ?? (settings.providers ? {} :
    provider === "huggingface" ? { apiKey: settings.localApiKey, baseUrl: settings.localBaseUrl } :
    provider === legacyProvider ? { apiKey: settings.apiKey, baseUrl: settings.baseUrl } : {});
  const key = config.apiKey || (provider === "openai" ? process.env.OPENAI_API_KEY : "") || "";
  return {
    apiKey: key || (provider === "huggingface" || (provider === "compatible" && config.baseUrl) ? "local-no-key" : ""),
    baseUrl: config.baseUrl || (provider === "huggingface" ? "http://localhost:8000/v1" : undefined),
    provider,
    source: config.apiKey ? ("panel" as const) : key ? ("env" as const) : ("none" as const),
  };
}

export const PROVIDERS: Provider[] = ["openai", "compatible", "huggingface"];
export function publicSettings(provider: Provider = readSettings().provider ?? "openai") {
  const configurations = PROVIDERS.map((id) => {
    const credentials = resolveCredentials(id);
    return { provider: id, keySource: credentials.source, baseUrl: credentials.baseUrl ?? "",
      hasPanelKey: credentials.source === "panel",
      runLocally: id === "huggingface" && !!readSettings().runLocally,
      configured: credentials.source !== "none" || (id === "huggingface" && !!readSettings().runLocally) ||
        (id !== "openai" && !!(readSettings().providers?.[id]?.baseUrl || (id === "huggingface" && readSettings().localBaseUrl))) };
  });
  return { ...configurations.find((config) => config.provider === provider)!, providers: configurations };
}
