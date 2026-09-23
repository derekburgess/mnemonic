import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.cwd(), "data");
const FILE = path.join(DIR, "settings.json");

/** Which API surface to speak. Responses is OpenAI's own; chat is the universal one. */
export type Provider = "openai" | "compatible" | "huggingface";

export type Settings = {
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

export function writeSettings(next: Settings): Settings {
  const current = readSettings();
  const patch = { ...next };
  if ((next.provider ?? current.provider) === "huggingface") {
    if (next.apiKey !== undefined) { patch.localApiKey = next.apiKey; delete patch.apiKey; }
    if (next.baseUrl !== undefined) { patch.localBaseUrl = next.baseUrl; delete patch.baseUrl; }
  }
  const merged = { ...current, ...patch };
  // An empty string clears a value rather than storing a blank.
  for (const key of Object.keys(merged) as (keyof Settings)[]) {
    if (!merged[key]) delete merged[key];
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  cached = merged;
  return merged;
}

/** The key in use, and where it came from. The panel takes precedence over the environment. */
export function resolveCredentials() {
  const settings = readSettings();
  if (settings.provider === "huggingface") {
    return {
      apiKey: settings.localApiKey || "local-no-key",
      baseUrl: settings.localBaseUrl || "http://localhost:8000/v1",
      provider: settings.provider,
      source: settings.localApiKey ? ("panel" as const) : ("none" as const),
    };
  }
  const apiKey = settings.apiKey || process.env.OPENAI_API_KEY || "";
  return {
    apiKey,
    baseUrl: settings.baseUrl || undefined,
    provider: settings.provider ?? ("openai" as Provider),
    source: settings.apiKey ? ("panel" as const) : apiKey ? ("env" as const) : ("none" as const),
  };
}
