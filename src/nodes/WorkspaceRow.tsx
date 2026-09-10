import { useEffect, useId, useState } from "react";
import { checkPath } from "../api";
import { Icon } from "../icons";

/**
 * One workspace: an editable path that completes as you type, a button to reopen the OS dialog,
 * and a remove button — the same shape as a link row.
 *
 * The path is always shown and always editable, because the browser cannot report where a
 * chosen folder is and what fills this field is therefore the proxy's best answer rather than
 * a certainty. The mark on the right says whether that answer is really a folder on this
 * machine, so a wrong guess is visible instead of silent.
 */
export function WorkspaceRow({
  path,
  busy,
  note,
  onChange,
  onBrowse,
  onRemove,
}: {
  path: string;
  busy: boolean;
  /** Set when the lookup was not conclusive, so a real-but-wrong folder is not silent. */
  note?: string;
  onChange: (path: string) => void;
  onBrowse: () => void;
  onRemove: () => void;
}) {
  const [found, setFound] = useState<boolean | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const listId = useId();

  useEffect(() => {
    // Typing a path character by character should not put a request behind every keystroke.
    let live = true;
    const timer = setTimeout(() => {
      checkPath(path)
        .then((r) => {
          if (!live) return;
          setFound(path.trim() ? r.exists && r.dir : null);
          setSuggestions(r.suggestions);
        })
        .catch(() => live && setFound(null));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path]);

  return (
    <>
      <div className="attachment">
        <input
          className="line nodrag"
          placeholder={busy ? "Locating…" : "/path/to/folder"}
          value={path}
          spellCheck={false}
          aria-label="Workspace folder"
          title={path || "Choose a folder, or type a path"}
          list={listId}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
        {/* Completion from the proxy, so a path can be walked to without a dialog — the only
            way in on a browser with no folder picker, and the way to correct a wrong guess
            everywhere else. */}
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>

        {found !== null && (
          <span
            className={`ws-mark${found ? " ok" : " bad"}`}
            title={found ? `${path} is a folder on this machine` : `${path} is not a folder on this machine`}
            aria-label={found ? "Folder found" : "Folder not found"}
          >
            {found ? "●" : "○"}
          </span>
        )}

        <button
          className="icon browse nodrag"
          onClick={onBrowse}
          disabled={busy}
          title="Choose a folder"
          aria-label="Choose a folder"
        >
          <Icon name="folder" size={11} />
        </button>
        <button
          className="icon tinted tint-err nodrag"
          onClick={onRemove}
          title="Remove workspace"
          aria-label="Remove workspace"
        >
          <Icon name="close" size={11} />
        </button>
      </div>
      {note && <p className="ws-note nodrag">{note}</p>}
    </>
  );
}
