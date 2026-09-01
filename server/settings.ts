import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.cwd(), "data");
const FILE = path.join(DIR, "settings.json");

/** Which API surface to speak. Responses is OpenAI's own; chat is the universal one. */
export type Provider = "openai" | "compatible";

export type Settings = {
  apiKey?: string;
  /** Blank means OpenAI's own endpoint. */
  baseUrl?: string;
  provider?: Provider;
};

let cached: Settings | null = null;

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
  const merged = { ...readSettings(), ...next };
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
  const apiKey = settings.apiKey || process.env.OPENAI_API_KEY || "";
  return {
    apiKey,
    baseUrl: settings.baseUrl || undefined,
    provider: settings.provider ?? ("openai" as Provider),
    source: settings.apiKey ? ("panel" as const) : apiKey ? ("env" as const) : ("none" as const),
  };
}
