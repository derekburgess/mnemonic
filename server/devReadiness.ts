import { setTimeout as delay } from "node:timers/promises";

/** Probe without replaying any application requests, especially writes and node runs. */
export async function waitForApi(target: string, timeoutMs = 180_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${target}/api/health`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))),
      });
      const body = await response.json();
      if (response.ok && body && typeof body === "object" &&
          "service" in body && body.service === "mnemonic" &&
          "status" in body && body.status === "ready") return;
    } catch { /* Expected while the API starts; its own logs carry initialization errors. */ }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(intervalMs, remaining));
  }
  throw new Error(`API at ${target} did not become ready within ${Math.round(timeoutMs / 1000)}s. Check the [server] logs and PORT configuration.`);
}
