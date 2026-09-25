import { useEffect, useState } from "react";
import { fetchSandboxStatus, type SandboxStatus } from "../api";

/**
 * Runs the step in an ephemeral container instead of in the proxy's own process.
 *
 * Whether that is possible is a fact about the proxy, not about any one step, so it is asked
 * once and shared by every node — otherwise a graph of twenty steps opens twenty requests to
 * say the same thing.
 */
let asked: Promise<SandboxStatus> | null = null;
const sandboxStatus = () => (asked ??= fetchSandboxStatus());

export function SandboxToggle({ on, onChange, required = false, useGpu = false, onGpuChange }: { useGpu?: boolean; onGpuChange: (v: boolean) => void; on: boolean; required?: boolean; onChange: (v: boolean) => void }) {
  const [status, setStatus] = useState<SandboxStatus | null>(null);

  useEffect(() => {
    let live = true;
    void sandboxStatus().then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, []);

  const available = status?.available ?? false;
  // A step already set to run contained keeps its switch usable even where this proxy cannot
  // honour it: the setting travels with the graph, and hiding it would look like it was lost.
  const locked = required || (!!status && !available && !on);

  return (
    <div className="stack">
      <div className="sandbox-row sandbox-controls nodrag">
      <label
        className={`sandbox-control${on ? " on" : ""}${locked ? " locked" : ""}`}
        title="Required for running local models."
      >
        <span className="skip sandbox">
          <input
            type="checkbox"
            checked={on}
            disabled={locked}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="track" aria-hidden="true" />
        </span>
        <span>Run in a sandbox</span>
      </label>

      {required && <label className="sandbox-control">
        <span className="skip sandbox">
          <input type="checkbox" checked={useGpu} disabled={!on || status?.gpuSupported === false}
            onChange={(e) => onGpuChange(e.target.checked)} />
          <span className="track" aria-hidden="true" />
        </span>
        <span>Use GPU</span>
      </label>}
      </div>

      {/* A step that asked to be contained and cannot be will fail rather than quietly run on
          the host, so the reason belongs here, before it is run. */}
      {on && status && !available && <p className="ws-note nodrag">{status.reason}</p>}
    </div>
  );
}
