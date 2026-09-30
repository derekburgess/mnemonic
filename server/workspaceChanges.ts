import { event, type EmitEvent } from "./events.js";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Mount } from "./sandbox.js";

const store = () => path.resolve("data/workspace-changes");
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
type File = { hash: string; data: string; mode: number };
type Change = { id: string; workspace: string; root: string; path: string; before?: File; after?: File; accepted?: boolean };
type Proposal = { id: string; changes: Change[] };
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });

// Never follow links or copy special files across the sandbox boundary.
async function readRegular(file: string): Promise<File> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure(`Not a regular file: ${file}`);
    if (stat.size > 16 * 1024 * 1024) throw failure(`Workspace file exceeds 16 MiB: ${file}`);
    const data = await handle.readFile();
    if (data.length > 16 * 1024 * 1024) throw failure(`Workspace file exceeds 16 MiB: ${file}`);
    return { hash: hash(data), data: data.toString("base64"), mode: stat.mode & 0o777 };
  } finally { await handle.close(); }
}

async function scan(root: string, signal?: AbortSignal, skipLinks = false) {
  const files = new Map<string, File>();
  let bytes = 0, entries = 0, skipped = 0;
  async function walk(dir: string, relative: string) {
    signal?.throwIfAborted();
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (++entries > 20_000) throw failure("Workspace exceeds 20,000 entries.");
      const absolute = path.join(dir, entry.name), name = path.join(relative, entry.name);
      // Git metadata and the application's own persistent data aren't run inputs.
      if (entry.name === ".git" || absolute === path.resolve("data")) { skipped++; continue; }
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        if (skipLinks) { skipped++; continue; }
        throw failure(`Sandbox created an unsupported link or special file: ${name}`);
      }
      if (stat.isDirectory()) await walk(absolute, name);
      else {
        const file = await readRegular(absolute);
        bytes += Buffer.byteLength(file.data, "base64");
        if (bytes > 256 * 1024 * 1024) throw failure("Workspace exceeds the 256 MiB copy limit.");
        files.set(name, file);
      }
    }
  }
  await walk(root, "");
  return { files, skipped };
}

/** Called at startup only after all old sandbox containers have been removed. */
export async function cleanupWorkspaceRuns() {
  const staging = path.resolve("data/workspace-runs");
  let entries;
  try { entries = await fs.readdir(staging, { withFileTypes: true }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
  for (const entry of entries) {
    if (entry.name.startsWith("run-")) await fs.rm(path.join(staging, entry.name), { recursive: true, force: true });
  }
}

export async function prepareWorkspaceCopies(mounts: Mount[], signal?: AbortSignal, emit?: EmitEvent) {
  const staging = path.resolve("data/workspace-runs");
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  const temporary = await fs.mkdtemp(path.join(staging, "run-"));
  const snapshots: { mount: Mount; root: string; copy: string; files: Map<string, File> }[] = [];
  let skipped = 0;
  try {
    for (const [i, mount] of mounts.entries()) {
      emit?.(event("proxy", "workspace.scanning", { workspace: mount.name, index: i + 1, count: mounts.length }));
      const root = await fs.realpath(mount.host);
      const { files, skipped: omitted } = await scan(root, signal, true);
      skipped += omitted;
      const copy = path.join(temporary, String(i));
      await fs.mkdir(copy, { mode: 0o777 });
      await fs.chmod(copy, 0o777);
      let copied = 0, bytes = 0, lastReport = 0;
      const totalBytes = [...files.values()].reduce((n, file) => n + Buffer.byteLength(file.data, "base64"), 0);
      emit?.(event("proxy", "workspace.copy_progress", { workspace: mount.name, copied, total: files.size, bytes, totalBytes }));
      for (const [name, file] of files) {
        signal?.throwIfAborted();
        const destination = path.join(copy, name);
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o777 });
        // Docker's node user can differ from the host uid. Only the disposable copy is writable.
        let parent = path.dirname(destination);
        while (parent !== temporary) { await fs.chmod(parent, 0o777); parent = path.dirname(parent); }
        await fs.writeFile(destination, Buffer.from(file.data, "base64"));
        await fs.chmod(destination, file.mode | 0o666);
        copied++; bytes += Buffer.byteLength(file.data, "base64");
        if (Date.now() - lastReport >= 500 || copied === files.size) {
          emit?.(event("proxy", "workspace.copy_progress", { workspace: mount.name, copied, total: files.size, bytes, totalBytes }));
          lastReport = Date.now();
        }
      }
      snapshots.push({ mount, root, copy, files });
    }
    return {
      mounts: snapshots.map((s) => ({ ...s.mount, host: s.copy })), skipped,
      cleanup: async () => {
        emit?.(event("proxy", "workspace.cleanup_started"));
        await fs.rm(temporary, { recursive: true, force: true });
        emit?.(event("proxy", "workspace.cleanup_completed"));
      },
      capture: async () => {
        emit?.(event("proxy", "workspace.changes_scanning"));
        const proposal: Proposal = { id: randomUUID(), changes: [] };
        for (const snapshot of snapshots) {
          const { files: after } = await scan(snapshot.copy, signal);
          for (const name of new Set([...snapshot.files.keys(), ...after.keys()])) {
            const before = snapshot.files.get(name), next = after.get(name);
            if (before?.hash === next?.hash) continue;
            proposal.changes.push({ id: String(proposal.changes.length), workspace: snapshot.mount.name,
              root: snapshot.root, path: name, before, after: next });
          }
        }
        if (!proposal.changes.length) return undefined;
        emit?.(event("proxy", "workspace.changes_saving", { count: proposal.changes.length }));
        await save(proposal);
        return proposal.id;
      },
    };
  } catch (err) {
    emit?.(event("proxy", "workspace.cleanup_started"));
    await fs.rm(temporary, { recursive: true, force: true });
    emit?.(event("proxy", "workspace.cleanup_completed"));
    throw err;
  }
}

function proposalPath(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw failure("Invalid change identifier.", 400);
  return path.join(store(), `${id}.json`);
}
async function save(proposal: Proposal) {
  await fs.mkdir(store(), { recursive: true, mode: 0o700 });
  const target = proposalPath(proposal.id), temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(proposal), { mode: 0o600 });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function load(id: string): Promise<Proposal> {
  try { return JSON.parse(await fs.readFile(proposalPath(id), "utf8")); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") throw failure("Saved workspace changes were not found.", 404); throw err; }
}

// Check every ancestor, including the original root, before touching a local path.
async function targetFor(change: Change) {
  const target = path.resolve(change.root, change.path);
  if (!target.startsWith(change.root + path.sep)) throw failure("Change escapes its workspace.");
  let current = path.parse(target).root;
  for (const part of path.relative(current, path.dirname(target)).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure(`Unsafe workspace path: ${current}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (current === change.root || change.root.startsWith(current + path.sep)) throw failure("Original workspace no longer exists.");
    }
  }
  return target;
}
async function conflict(change: Change) {
  try {
    const target = await targetFor(change);
    let current: File | undefined;
    try { current = await readRegular(target); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    return current?.hash !== change.before?.hash || (current && change.before && current.mode !== change.before.mode)
      ? "File changed locally since this run." : undefined;
  } catch (err) { return (err as Error).message; }
}
function preview(file?: File) {
  if (!file) return null;
  const bytes = Buffer.from(file.data, "base64");
  const text = bytes.toString("utf8");
  const binary = bytes.includes(0) || !Buffer.from(text).equals(bytes);
  return { bytes: bytes.length, text: binary ? null : text.slice(0, 200_000), binary, truncated: !binary && text.length > 200_000 };
}
export async function workspaceChangesSummary(id: string) {
  const proposal = await load(id);
  return { id, pending: proposal.changes.filter((change) => !change.accepted).length };
}

export async function reviewWorkspaceChanges(id: string) {
  const proposal = await load(id);
  return { id, changes: await Promise.all(proposal.changes.map(async (c) => ({ id: c.id, workspace: c.workspace,
    path: c.path, kind: !c.before ? "added" : !c.after ? "deleted" : "modified", accepted: !!c.accepted,
    conflict: c.accepted ? undefined : await conflict(c), before: preview(c.before), after: preview(c.after) }))) };
}

let accepting = false;
export async function acceptWorkspaceChanges(id: string, selected: string[]) {
  if (accepting) throw failure("Another acceptance is in progress. Try again.");
  accepting = true;
  try {
    const proposal = await load(id);
    if (!Array.isArray(selected) || !selected.length || selected.some((key) => typeof key !== "string" || !proposal.changes.some((c) => c.id === key))) {
      throw failure("Select files to accept.", 400);
    }
    const changes = proposal.changes.filter((c) => selected.includes(c.id) && !c.accepted);
    for (const change of changes) {
      const reason = await conflict(change);
      if (reason) throw failure(`${change.workspace}/${change.path}: ${reason}`);
    }
    for (const change of changes) {
      const reason = await conflict(change);
      if (reason) throw failure(`${change.workspace}/${change.path}: ${reason}`);
      const target = await targetFor(change);
      if (!change.after) await fs.unlink(target);
      else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await targetFor(change);
        const temporary = path.join(path.dirname(target), `.mnemonic-${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, Buffer.from(change.after.data, "base64"), { flag: "wx", mode: change.before?.mode ?? 0o644 });
          if (change.before) await fs.rename(temporary, target);
          else await fs.link(temporary, target); // Creation must never overwrite a newly created file.
        } finally { await fs.rm(temporary, { force: true }); }
      }
      change.accepted = true;
      await save(proposal); // Preserve partial progress if a later filesystem operation fails.
    }
    return await reviewWorkspaceChanges(id);
  } finally { accepting = false; }
}
