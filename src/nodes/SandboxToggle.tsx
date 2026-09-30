import { Icon } from "../icons";
import { useEffect, useState } from "react";
import { fetchSandboxStatus, type SandboxStatus } from "../api";

/**
 * Runs the step in an ephemeral container instead of in the proxy's own process.
 *
 * Whether that is possible is a fact about the proxy, not about any one step, so it is asked
 * with concurrent requests shared across nodes. Don't retain a failed startup check forever.
 */
let asked: Promise<SandboxStatus> | null = null;
const sandboxStatus = () => (asked ??= fetchSandboxStatus().finally(() => { asked = null; }));

export function SandboxToggle({ onConfigure, on, onChange, required = false, useGpu = false, onGpuChange }: { onConfigure: () => void; useGpu?: boolean; onGpuChange: (v: boolean) => void; on: boolean; required?: boolean; onChange: (v: boolean) => void }) {
  const [status, setStatus] = useState<SandboxStatus | null>(null);

  useEffect(() => {
    let live = true;
    void sandboxStatus().then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, [on]);

  const available = status?.available ?? false;
  // This is the node's execution preference, not a reflection of Docker's current health.
  // The server checks availability at run time and never falls back to host execution.
  const locked = required;

  return (
    <div className="stack">
      <div className="sandbox-row sandbox-controls nodrag">
      <button className="icon sandbox-config-open" aria-label="Sandbox configuration" onClick={onConfigure}><Icon name="gear" size={13} /></button>
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
