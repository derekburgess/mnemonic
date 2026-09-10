/**
 * Opens the operating system's own folder dialog. Every browser has one; they differ only in how
 * you reach it.
 *
 * `showDirectoryPicker` (Chromium) is preferred because it returns a handle and reads nothing.
 * Firefox and Safari do not implement it, so they take `<input webkitdirectory>`, which opens the
 * same native chooser and then asks the user to confirm — the browser warns because that route
 * *can* hand a page every file in the folder. We read nothing but names from it, but the warning
 * is the browser's to show and cannot be suppressed.
 *
 * Neither route says where the folder is. What comes back is its name and the names directly
 * inside it, which is what the proxy uses to find it for real.
 */
export type PickedFolder = { name: string; entries: string[] };

/** Enough to identify a folder without waiting on a large one. */
const MAX_ENTRIES = 60;

type DirectoryHandle = { name: string; keys: () => AsyncIterableIterator<string> };

type PickerWindow = {
  showDirectoryPicker?: (options?: { mode?: string }) => Promise<DirectoryHandle>;
};

/**
 * Which route this browser will take. "confirm" means the browser will ask before handing the
 * folder over, which is worth saying up front rather than letting it read as a warning about
 * this app.
 */
export const pickerKind = (): "direct" | "confirm" =>
  typeof (window as unknown as PickerWindow).showDirectoryPicker === "function" ? "direct" : "confirm";

/** Resolves to null when the dialog is dismissed, leaving the row exactly as it was. */
export async function pickDirectory(): Promise<PickedFolder | null> {
  const w = window as unknown as PickerWindow;
  if (typeof w.showDirectoryPicker !== "function") return pickViaInput();

  let handle: DirectoryHandle;
  try {
    // Called on `window` rather than through a detached reference: the API throws
    // "Illegal invocation" if it loses its receiver.
    handle = await w.showDirectoryPicker({ mode: "read" });
  } catch {
    return null; // dismissed, or the page is not allowed to ask
  }

  const entries: string[] = [];
  try {
    for await (const name of handle.keys()) {
      entries.push(name);
      if (entries.length >= MAX_ENTRIES) break;
    }
  } catch {
    /* the name alone is still worth returning */
  }
  return { name: handle.name, entries };
}

/**
 * The route Firefox and Safari take: a file input in directory mode, which opens the same native
 * folder chooser. The browser then asks the user to confirm, because this API *can* expose every
 * file in the folder — only names are read here, and no contents are ever touched.
 */
function pickViaInput(): Promise<PickedFolder | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    // Not in the HTML spec, so not on the TS element type, but this is what opens the chooser.
    (input as unknown as { webkitdirectory: boolean }).webkitdirectory = true;
    input.style.display = "none";

    const done = (value: PickedFolder | null) => {
      input.remove();
      resolve(value);
    };

    // Dismissing fires `cancel` in current browsers. Where it does not, the promise simply never
    // settles and the row is left empty — which is what dismissing should do anyway.
    input.addEventListener("cancel", () => done(null));
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return done(null);

      // webkitRelativePath is "<folder>/<child>/…", so the first segment names the folder and
      // the second names something directly inside it. Nothing else is read, and no file is
      // ever opened.
      const name = files[0].webkitRelativePath.split("/")[0] ?? "";
      const entries = new Set<string>();
      for (const file of files) {
        const segments = file.webkitRelativePath.split("/");
        if (segments.length > 1) entries.add(segments[1]);
        if (entries.size >= MAX_ENTRIES) break;
      }
      done(name ? { name, entries: [...entries] } : null);
    });

    document.body.append(input);
    input.click();
  });
}
