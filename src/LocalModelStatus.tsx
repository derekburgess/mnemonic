import { useEffect, useState } from "react";
type LocalActivity = { phase: string; model: string; downloaded?: number; total?: number; message?: string; queued: number };

const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(0)} MB`;

export function LocalModelStatus() {
  const [activity, setActivity] = useState<LocalActivity | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/local-model/status", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]) });
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (!controller.signal.aborted) setActivity(body.activity);
      } catch { if (!controller.signal.aborted) setActivity(null); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 750);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  if (!activity) return null;
  const determinate = activity.total !== undefined && activity.total > 0;
  return (
    <div className="local-model-status" title={`${activity.model}${activity.message ? `: ${activity.message}` : ""}`}>
      <span role="status" className="local-model-label">{activity.phase} · {activity.model}
        {activity.queued > 0 && ` · ${activity.queued} queued`}</span>
      {activity.phase === "Downloading" && <div className="local-model-progress">
        <progress aria-label={`Downloading ${activity.model}`} max={determinate ? activity.total : undefined}
          value={determinate ? Math.min(activity.downloaded ?? 0, activity.total!) : undefined} />
        {determinate && <span>{bytes(activity.downloaded ?? 0)} / {bytes(activity.total!)}</span>}
      </div>}
    </div>
  );
}
