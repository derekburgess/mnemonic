import type { WorkspaceToolSettings } from "../src/toolSettings.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * A workspace is a folder on this machine that a step lends to the model, held as an absolute
 * path.
 *
 * No browser API can produce that path. `showDirectoryPicker()` returns a handle and
 * `webkitdirectory` a set of relative paths; neither is a location, Firefox labels the second
 * one "Upload", and Chromium interrupts it with a confirmation about uploading every file in
 * the folder. All of that is the wrong shape for choosing a folder to work in.
 *
 * The proxy runs on the same machine as the browser, so it opens the desktop's own folder
 * chooser instead and reads the path straight off it. Nothing is enumerated, nothing is
 * uploaded, and every browser behaves the same because none of them are involved.
 */

/** What one entry of a directory listing looks like, for the picker and for the model alike. */
export type Entry = { name: string; dir: boolean; size?: number; hidden: boolean };

/** A listing is truncated rather than allowed to fill a context window (or a modal). */
const MAX_ENTRIES = 2000;

/** Files past this are reported by size instead of read; text is what these tools are for. */
const MAX_READ_BYTES = 256 * 1024;

export const homeDir = () => os.homedir();

const isHidden = (name: string) => name.startsWith(".");

/** `~` is what people actually type, and what the picker's home button hands back. */
export function expandHome(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homeDir();
  if (trimmed.startsWith("~/")) return path.join(homeDir(), trimmed.slice(2));
  return trimmed;
}

async function entriesOf(dir: string): Promise<Entry[]> {
  const found = await fs.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    found.slice(0, MAX_ENTRIES).map(async (d) => {
      // A symlink reports as neither file nor directory, so ask what it points at; a broken
      // one is listed as a file rather than dropped, so it is visible instead of missing.
      let dirent = d.isDirectory();
      let size: number | undefined;
      try {
        const stat = await fs.stat(path.join(dir, d.name));
        dirent = stat.isDirectory();
        size = stat.isFile() ? stat.size : undefined;
      } catch {
        /* unreadable: keep what the dirent claimed */
      }
      return { name: d.name, dir: dirent, size, hidden: isHidden(d.name) };
    }),
  );

  // Folders first, then files, each alphabetical and case-insensitive — the order every file
  // browser uses, so the picker reads the way people expect.
  return entries.sort(
    (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/* -------------------------------------------------------------------------- */
/* The desktop's own folder chooser                                            */
/* -------------------------------------------------------------------------- */

const run = promisify(execFile);

/** Long enough to go and find the folder, short enough that a forgotten dialog dies. */
const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

/** The dialog is modal to the desktop, so a second one would be a second window nobody asked for. */
let openDialog: Promise<PickResult> | null = null;

export type PickResult = { path: string } | { cancelled: true };

type Recipe = { cmd: string; args: (start?: string) => string[] };

/**
 * How each desktop is asked for a folder. Tried in order, first one installed wins — the GTK
 * and Qt helpers are the same dialogs the rest of the desktop uses.
 */
function recipes(): Recipe[] {
  if (process.platform === "darwin") {
    return [
      {
        cmd: "osascript",
        args: (start) => [
          "-e",
          `POSIX path of (choose folder with prompt "Choose a workspace folder"${
            start ? ` default location POSIX file ${JSON.stringify(start)}` : ""
          })`,
        ],
      },
    ];
  }

  if (process.platform === "win32") {
    return [
      {
        cmd: "powershell",
        args: () => [
          "-NoProfile",
          "-STA",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms;" +
            "$d=New-Object System.Windows.Forms.FolderBrowserDialog;" +
            "if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}",
        ],
      },
    ];
  }

  // Linux and the BSDs: zenity is GTK, kdialog is KDE, qarma is the Qt port of zenity.
  return [
    {
      cmd: "zenity",
      args: (start) => [
        "--file-selection",
        "--directory",
        "--title=Choose a workspace folder",
        // A trailing separator is what tells GTK to open *inside* the folder.
        ...(start ? [`--filename=${start.replace(/\/*$/, "/")}`] : []),
      ],
    },
    {
      cmd: "qarma",
      args: (start) => [
        "--file-selection",
        "--directory",
        "--title=Choose a workspace folder",
        ...(start ? [`--filename=${start.replace(/\/*$/, "/")}`] : []),
      ],
    },
    {
      cmd: "kdialog",
      args: (start) => ["--getexistingdirectory", start || homeDir()],
    },
  ];
}

const which = async (cmd: string) => {
  try {
    // `where` on Windows, `command -v` everywhere else; both answer non-zero when absent.
    if (process.platform === "win32") await run("where", [cmd]);
    else await run("sh", ["-c", `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
};

/** Whether this machine can show a folder chooser at all, and which helper would do it. */
async function nativeDialog(): Promise<{ available: boolean; via?: string }> {
  // The chooser opens on the machine running the proxy, which is the machine whose files the
  // workspace tools read — so that is the right screen for it, as long as it is your screen.
  //
  // It is not, if you are port-forwarding to a proxy on a dev box: the window would open there,
  // unseen. Neither end can detect that. Vite forwards /api server-side, so the proxy always
  // sees a loopback client however far away the browser is, and a forwarded port makes the page
  // "localhost" to the browser. So it is a switch rather than a guess.
  if (/^(0|off|false|no)$/i.test(process.env.MNEMONIC_FOLDER_DIALOG ?? "")) {
    return { available: false };
  }

  // A proxy on a headless box has no desktop to put a window on, and X11 says so via DISPLAY.
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return { available: false };
  }
  for (const { cmd } of recipes()) {
    if (await which(cmd)) return { available: true, via: cmd };
  }
  return { available: false };
}

/**
 * Opens the desktop's folder chooser and returns what was picked. The window appears on the
 * machine running the proxy, which for a local tool is the same machine as the browser.
 */
export async function nativePick(start?: string): Promise<PickResult> {
  // Serialised rather than queued: a click while a chooser is already up should reach the one
  // already on screen, not stack another behind it.
  if (openDialog) return openDialog;

  openDialog = (async (): Promise<PickResult> => {
    // Checked before running anything: a helper that is installed but has no display to draw on
    // exits non-zero, which would otherwise be indistinguishable from the user cancelling — and
    // the browser's own fallback would never get its turn.
    if (!(await nativeDialog()).available) {
      throw Object.assign(new Error("no folder chooser available on this machine"), { status: 501 });
    }

    const from = start?.trim() ? path.resolve(expandHome(start)) : undefined;
    const usable = from && (await check(from)).dir ? from : undefined;

    for (const recipe of recipes()) {
      if (!(await which(recipe.cmd))) continue;
      try {
        const { stdout } = await run(recipe.cmd, recipe.args(usable), {
          timeout: DIALOG_TIMEOUT_MS,
        });
        const picked = stdout.trim().split("\n")[0]?.trim();
        // Every one of these helpers exits non-zero on cancel, so an empty success is only
        // ever a helper that had nothing to say.
        return picked ? { path: path.resolve(picked) } : { cancelled: true };
      } catch (err) {
        const e = err as { code?: number | string; killed?: boolean };
        // 1 is cancel for zenity/qarma/kdialog; osascript answers 1 on cancel too.
        if (e.code === 1 || e.killed) return { cancelled: true };
        continue; // this helper is broken; try the next
      }
    }
    throw Object.assign(new Error("no folder chooser available on this machine"), { status: 501 });
  })();

  try {
    return await openDialog;
  } finally {
    openDialog = null;
  }
}

/** How many folders the path field offers at once. */
const MAX_SUGGESTIONS = 20;

/**
 * Backs the workspace path field: whether what is typed is really a folder here, and what it
 * could be completed to. Both in one answer, because the field asks after every pause in typing
 * and there is no reason to make that two round trips.
 */
export async function check(input: string): Promise<{
  exists: boolean;
  dir: boolean;
  path: string;
  suggestions: string[];
}> {
  const raw = input.trim();
  const target = path.resolve(expandHome(raw || homeDir()));

  let exists = false;
  let dir = false;
  if (raw) {
    try {
      const stat = await fs.stat(target);
      exists = true;
      dir = stat.isDirectory();
    } catch {
      /* absent is an answer, not an error */
    }
  }
  return { exists, dir, path: target, suggestions: await suggest(raw) };
}

/**
 * Completes the last segment against its parent, or lists inside the folder when the text
 * already ends in a separator — how a shell completes a path, which is what people expect from
 * a field holding one. Hidden folders stay out of the way until the segment starts with a dot.
 */
async function suggest(raw: string): Promise<string[]> {
  let parent: string;
  let partial: string;

  if (!raw) {
    parent = homeDir();
    partial = "";
  } else if (/[/\\]$/.test(raw)) {
    parent = expandHome(raw);
    partial = "";
  } else {
    const expanded = expandHome(raw);
    parent = path.dirname(expanded);
    partial = path.basename(expanded);
  }

  const wanted = partial.toLowerCase();
  try {
    const found = await fs.readdir(path.resolve(parent), { withFileTypes: true });
    return found
      .filter((d) => d.isDirectory())
      .filter((d) => (partial.startsWith(".") ? true : !isHidden(d.name)))
      .filter((d) => d.name.toLowerCase().startsWith(wanted))
      .map((d) => path.join(path.resolve(parent), d.name))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .slice(0, MAX_SUGGESTIONS);
  } catch {
    return []; // an unreadable or half-typed parent simply offers nothing
  }
}

/* -------------------------------------------------------------------------- */
/* Locating a folder the OS picker chose                                       */
/* -------------------------------------------------------------------------- */

/**
 * The browser will not say where a chosen folder is. The OS dialog gives its *name* and, once
 * opened, the names directly inside it — and that pair is nearly always enough to find it: a
 * folder called "mnemonic" that contains "server", "src" and "package.json" is not ambiguous in
 * practice. So the browser sends those, and this walks the likely parts of the filesystem
 * looking for the one folder that matches both.
 *
 * The answer is a suggestion, never a commitment: it lands in a field you can see and edit.
 */

/** Trees that are always large and never what someone picked deliberately. */
const SKIP = new Set([
  "node_modules", ".git", ".cache", ".npm", ".venv", "venv", "__pycache__", ".next", ".nuxt",
  "dist", "build", "target", ".gradle", ".m2", "site-packages", ".Trash", "Library", "snap",
  ".local", ".rustup", ".cargo", ".conda", ".anaconda", ".nvm", ".pyenv",
]);

/** Bounds on the search, so a click can never hang on a pathological filesystem. */
const MAX_DEPTH = 7;
const MAX_VISITED = 40_000;
const SEARCH_BUDGET_MS = 2500;

/** Where a folder someone picked plausibly lives. */
function searchRoots(): string[] {
  const roots = [homeDir(), process.cwd(), "/mnt", "/media", "/Volumes", "/srv", "/data", "/opt"];
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

export type FolderMatch = { path: string; score: number };

/**
 * Breadth-first so shallow matches surface first, which is also the order that makes a tie
 * sensible: `~/repos/notes` beats `~/repos/old/archive/notes`.
 */
export async function findFolder(name: string, contains: string[] = []): Promise<FolderMatch[]> {
  const wanted = name.trim();
  if (!wanted) return [];

  const expected = new Set(contains.filter(Boolean));
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const matches: FolderMatch[] = [];
  const seen = new Set<string>();
  let visited = 0;

  let frontier = searchRoots();
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
    const next: string[] = [];

    for (const dir of frontier) {
      if (visited++ > MAX_VISITED || Date.now() > deadline) return rank(matches);

      let children: import("node:fs").Dirent[];
      try {
        children = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable or gone: not a reason to stop searching everywhere else
      }

      for (const child of children) {
        if (!child.isDirectory() || SKIP.has(child.name)) continue;
        const full = path.join(dir, child.name);
        // A symlinked tree can otherwise be walked forever, or twice.
        if (seen.has(full)) continue;
        seen.add(full);

        if (child.name === wanted) {
          matches.push({ path: full, score: await overlap(full, expected) });
        }
        next.push(full);
      }
    }

    // Once something matches on both name and contents, deeper candidates cannot beat it.
    if (matches.some((m) => expected.size > 0 && m.score === expected.size)) break;
    frontier = next;
  }

  return rank(matches);
}

/** How many of the entries the browser saw are actually in this candidate. */
async function overlap(dir: string, expected: Set<string>): Promise<number> {
  if (!expected.size) return 0;
  try {
    const names = new Set((await fs.readdir(dir)).map((n) => n));
    let hits = 0;
    for (const name of expected) if (names.has(name)) hits++;
    return hits;
  } catch {
    return 0;
  }
}

/** Best contents match first, then the shallowest path — the one a person would have meant. */
const rank = (matches: FolderMatch[]): FolderMatch[] =>
  matches
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.path.split(path.sep).length - b.path.split(path.sep).length ||
        a.path.localeCompare(b.path),
    )
    .slice(0, 10);

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

type Root = { name: string; dir: string };

/**
 * Roots are addressed by name rather than by their full path, so a prompt does not leak the
 * shape of your home directory and the model has something short to write. Two workspaces
 * ending in the same folder name are disambiguated by a suffix.
 */
function nameRoots(dirs: string[]): Root[] {
  const used = new Map<string, number>();
  return dirs.map((dir) => {
    const base = path.basename(dir) || dir;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return { name: seen ? `${base}-${seen + 1}` : base, dir };
  });
}

/**
 * The canonical path -> named root mapping: resolved, `~` expanded, duplicates collapsed. The
 * container mounts each workspace under its name from here, so a step sees the same root names
 * whether or not it is contained.
 */
export const workspaceNames = (dirs: string[]): Root[] =>
  nameRoots([...new Set(dirs.map((d) => path.resolve(expandHome(d))).filter(Boolean))]);

const within = (root: string, target: string) =>
  target === root || target.startsWith(root + path.sep);

/**
 * Resolves what the model asked for to a real path inside a workspace, or refuses.
 *
 * Containment is checked twice: once on the lexical path, and again on the nearest ancestor
 * that actually exists, resolved through its symlinks. The second check is the one that
 * matters — a symlink inside the workspace pointing at /etc passes the first.
 */
async function resolveInRoots(roots: Root[], input: unknown): Promise<string> {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw new Error("path is required");

  const expanded = expandHome(raw);
  const [head, ...rest] = expanded.split(/[/\\]/).filter(Boolean);
  const named = roots.find((r) => r.name === head);

  const target = named
    ? path.resolve(named.dir, ...rest)
    : path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : roots.length === 1
        ? path.resolve(roots[0].dir, expanded)
        : (() => {
            throw new Error(
              `"${raw}" does not name a workspace. Start the path with one of: ${roots
                .map((r) => r.name)
                .join(", ")}.`,
            );
          })();

  const home = roots.find((r) => within(r.dir, target));
  if (!home) {
    throw new Error(
      `"${raw}" is outside every workspace on this step. Available: ${roots
        .map((r) => r.name)
        .join(", ")}.`,
    );
  }

  // Walk up to the closest existing ancestor: a write to a file that does not exist yet still
  // has to be checked, and realpath only works on something that is there.
  let probe = target;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const suffix = path.relative(probe, target);
      const resolved = suffix ? path.join(real, suffix) : real;
      const realRoot = await fs.realpath(home.dir);
      if (!within(realRoot, resolved)) {
        throw new Error(`"${raw}" resolves through a link to somewhere outside the workspace.`);
      }
      return resolved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const up = path.dirname(probe);
      if (up === probe) throw new Error(`"${raw}" is outside every workspace on this step.`);
      probe = up;
    }
  }
}

/** How a path is written back to the model: rooted at the workspace name, never absolute. */
const display = (roots: Root[], target: string) => {
  const home = roots.find((r) => within(r.dir, target));
  if (!home) return target;
  const rel = path.relative(home.dir, target);
  return rel ? path.join(home.name, rel) : home.name;
};

export type WorkspaceTool = {
  definition: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
};

/** Model arguments arrive as whatever JSON it produced, so nothing is assumed about a field. */
const asText = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The three tools a workspace carries. There is deliberately no `cd`: every path is resolved
 * against a named root, so there is no working directory to move and no per-step state to keep
 * in sync with a model that may call these in any order.
 */
export function buildWorkspaceTools(dirs: string[]): Record<string, WorkspaceTool> {
  const roots = workspaceNames(dirs);
  if (!roots.length) return {};

  const where = roots.map((r) => `${r.name} (${r.dir})`).join(", ");
  const resolve = (p: unknown) => resolveInRoots(roots, p);

  return {
    workspace_list: {
      definition: {
        type: "function",
        name: "workspace_list",
        description:
          `List the contents of a folder in the workspaces attached to this step: ${where}. ` +
          `Paths start with the workspace name, e.g. "${roots[0].name}/src". ` +
          `Call it with no path to list the workspace roots themselves.`,
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Folder to list, rooted at a workspace name. Omit to list the roots.",
            },
          },
          additionalProperties: false,
        },
        strict: false,
      },
      run: async (args) => {
        if (!asText(args.path).trim()) {
          return { workspaces: roots.map((r) => ({ path: r.name, location: r.dir, dir: true })) };
        }
        const target = await resolve(args.path);
        const stat = await fs.stat(target);
        if (!stat.isDirectory()) {
          return { path: display(roots, target), dir: false, size: stat.size };
        }
        const entries = await entriesOf(target);
        return {
          path: display(roots, target),
          entries: entries.map((e) => ({ name: e.name, type: e.dir ? "dir" : "file", ...(e.size !== undefined ? { size: e.size } : {}) })),
          ...(entries.length >= MAX_ENTRIES ? { truncated: `listing capped at ${MAX_ENTRIES} entries` } : {}),
        };
      },
    },

    workspace_read: {
      definition: {
        type: "function",
        name: "workspace_read",
        description:
          `Read a text file from the workspaces attached to this step: ${where}. ` +
          `Paths start with the workspace name, e.g. "${roots[0].name}/README.md".`,
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "File to read, rooted at a workspace name." } },
          required: ["path"],
          additionalProperties: false,
        },
        strict: false,
      },
      run: async (args) => {
        const asked = asText(args.path);
        const target = await resolve(asked);
        const stat = await fs.stat(target);
        if (stat.isDirectory()) throw new Error(`"${asked}" is a folder; use workspace_list.`);
        if (stat.size > MAX_READ_BYTES) {
          throw new Error(`"${asked}" is ${stat.size} bytes, past the ${MAX_READ_BYTES}-byte read limit.`);
        }
        const buffer = await fs.readFile(target);
        // A NUL byte in the first block is the usual tell for binary; returning it as UTF-8
        // would be mojibake the model then has to reason about.
        if (buffer.subarray(0, 8000).includes(0)) {
          throw new Error(`"${asked}" looks like a binary file (${stat.size} bytes).`);
        }
        return { path: display(roots, target), bytes: stat.size, content: buffer.toString("utf8") };
      },
    },

    workspace_write: {
      definition: {
        type: "function",
        name: "workspace_write",
        description:
          `Write a text file into the workspaces attached to this step: ${where}. ` +
          `Creates missing folders and overwrites an existing file. ` +
          `Paths start with the workspace name, e.g. "${roots[0].name}/notes.md".`,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File to write, rooted at a workspace name." },
            content: { type: "string", description: "The file's full new contents." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        strict: false,
      },
      run: async (args) => {
        const target = await resolve(asText(args.path));
        const content = typeof args.content === "string" ? args.content : String(args.content ?? "");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
        return { path: display(roots, target), bytes: Buffer.byteLength(content), written: true };
      },
    },
  };
}

/** A line for the system prompt, describing only enabled workspace tools. */
export function describeWorkspaces(dirs: string[], settings: WorkspaceToolSettings = {}): string | undefined {
  const roots = workspaceNames(dirs);
  const names = ["workspace_list", "workspace_read", "workspace_write"] as const;
  const enabled = names.filter((name) => settings[name] !== false);
  if (!roots.length || !enabled.length) return undefined;
  return (
    `You have ${roots.length === 1 ? "a workspace" : "workspaces"} on this machine, reachable ` +
    `with ${enabled.join(", ")}. Paths are rooted at the ` +
    `workspace name:\n` +
    roots.map((r) => `- ${r.name} — ${r.dir}`).join("\n")
  );
}
