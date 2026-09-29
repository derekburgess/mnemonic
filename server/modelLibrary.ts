import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync, lstatSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { acquireModelIfIdle, withLocalModel } from "./localModels.js";
import { resolveCredentials } from "./settings.js";
import { redactText } from "./events.js";

const cache = path.resolve("data/models");
const indexFile = path.resolve("data/model-downloads.json");
type RecordEntry = { status: string; error?: string };
export type LibraryModel = RecordEntry & { model: string; bytes: number; active: boolean; downloaded?: number; total?: number };
const tasks = new Map<string, { controller: AbortController; status: string; downloaded?: number; total?: number }>();
let index: Record<string, RecordEntry> = Object.create(null);
try { index = Object.assign(Object.create(null), JSON.parse(readFileSync(indexFile, "utf8"))); } catch { /* first use */ }

export function validateModelId(value: unknown): string {
  if (typeof value !== "string" || value.length > 192 || !/^[\w][\w.-]*(?:\/[\w][\w.-]*)?$/.test(value)
      || value.includes("..") || value.includes("--") || /[.-]($|\/)/.test(value)) {
    throw new Error("Enter a Hugging Face model ID, such as organization/model-name.");
  }
  return value;
}
const repoPath = (model: string) => path.join(cache, `models--${validateModelId(model).replaceAll("/", "--")}`);
function saveIndex() {
  mkdirSync(path.dirname(indexFile), { recursive: true });
  writeFileSync(`${indexFile}.tmp`, JSON.stringify(index, null, 2));
  renameSync(`${indexFile}.tmp`, indexFile);
}

export function modelDownloaded(model: string): boolean {
  try {
    const root = repoPath(model);
    if (!lstatSync(root).isDirectory()) return false;
    const marker = JSON.parse(readFileSync(path.join(root, ".mnemonic-ready.json"), "utf8"));
    if (marker.model !== model || !/^[a-f0-9]{40}$/.test(marker.revision) || !Array.isArray(marker.files) || !marker.files.length) return false;
    return marker.files.every((file: { name: string; size: number }) => {
      if (typeof file.name !== "string" || path.isAbsolute(file.name) || file.name.split(/[\\/]/).includes("..")) return false;
      return statSync(path.join(root, "snapshots", marker.revision, file.name)).size === file.size;
    });
  } catch { return false; }
}
function diskBytes(model: string): number {
  try {
    return readdirSync(path.join(repoPath(model), "blobs"), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .reduce((sum, entry) => sum + statSync(path.join(repoPath(model), "blobs", entry.name)).size, 0);
  } catch { return 0; }
}

export function listLibrary(): LibraryModel[] {
  const models = new Set([...Object.keys(index), ...tasks.keys()]);
  try {
    for (const entry of readdirSync(cache, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("models--")) {
        const model = entry.name.slice(8).replaceAll("--", "/");
        try { models.add(validateModelId(model)); } catch { /* foreign cache directory */ }
      }
    }
  } catch { /* empty cache */ }
  return [...models].sort().map((model) => {
    const task = tasks.get(model);
    const ready = modelDownloaded(model);
    const stored = index[model];
    return { model, bytes: diskBytes(model), active: !!task, status: task?.status ?? (ready ? "Downloaded" : stored?.status === "Error" || stored?.status === "Cancelled" ? stored.status : "Incomplete"),
      error: task || ready ? undefined : stored?.error, downloaded: task?.downloaded, total: task?.total };
  });
}

export function startDownload(value: unknown) {
  const model = validateModelId(value);
  if (tasks.has(model)) return;
  if (modelDownloaded(model)) return;
  const controller = new AbortController();
  const task = { controller, status: "Queued", downloaded: undefined as number | undefined, total: undefined as number | undefined };
  tasks.set(model, task);
  index[model] = { status: "Queued" };
  try { saveIndex(); } catch (err) { tasks.delete(model); throw err; }
  const credentials = resolveCredentials("huggingface");
  const token = credentials.source === "none" ? undefined : credentials.apiKey;
  let diagnostic = "";
  void withLocalModel({ model, token, signal: controller.signal, mode: "download", emit: (entry) => {
    const detail = entry.detail as { phase?: string; downloaded?: number; total?: number; log?: string; text?: string } | undefined;
    if (detail?.log || detail?.text) diagnostic = (detail.log ?? detail.text ?? "").slice(-2000);
    if (detail?.phase && detail.phase !== "Unloading") {
      task.status = detail.phase;
      task.downloaded = detail.downloaded;
      task.total = detail.total;
    }
  } }, async () => {}, 0).then(() => {
    if (!modelDownloaded(model)) throw new Error("Download finished without a complete model cache. Retry the download.");
    index[model] = { status: "Downloaded" };
  }).catch((err: Error) => {
    index[model] = { status: controller.signal.aborted ? "Cancelled" : "Error", error: redactText(`${err.message}${diagnostic ? `\n${diagnostic}` : ""}`, [token ?? ""]) };
  }).finally(() => {
    tasks.delete(model);
    try { saveIndex(); } catch (err) { console.error("[mnemonic] could not persist model download status:", err); }
  });
}

export function cancelDownload(value: unknown) {
  const task = tasks.get(validateModelId(value));
  if (task) { task.status = "Cancelling"; task.controller.abort(); }
}

export async function deleteDownload(value: unknown) {
  const model = validateModelId(value);
  if (tasks.has(model)) throw new Error("Cancel this download before deleting its cached files.");
  const release = await acquireModelIfIdle();
  try {
    // Derived solely from a validated repository ID, never an arbitrary client path.
    await rm(repoPath(model), { recursive: true, force: true });
    const locks = path.join(cache, ".locks");
    try {
      if (lstatSync(locks).isDirectory()) await rm(path.join(locks, path.basename(repoPath(model))), { recursive: true, force: true });
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    delete index[model]; saveIndex();
  } finally { release(); }
}
