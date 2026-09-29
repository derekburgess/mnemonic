import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";

export const TIMEOUT_MESSAGE = 'The step hit its timeout. Raise "Timeout" if it legitimately takes longer.';

/** One absolute deadline, shared by preparation, model rounds and tools. */
export class ExecutionBudget {
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  // HTTP inactivity/connect timers must not preempt the node's deadline. The signal below
  // bounds the entire request, including reading its body, rather than each network phase.
  private readonly agent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 0 } });

  constructor(timeoutSec = 300, parent?: AbortSignal, deadlineMs = Date.now() + timeoutSec * 1000) {
    this.deadlineMs = deadlineMs;
    this.signal = parent ? AbortSignal.any([parent, this.controller.signal]) : this.controller.signal;
    const expire = () => this.controller.abort(new DOMException(TIMEOUT_MESSAGE, "TimeoutError"));
    this.timer = setTimeout(expire, Math.max(0, deadlineMs - Date.now()));
    this.timer.unref();
    if (deadlineMs <= Date.now()) expire();
  }

  remainingMs() {
    this.signal.throwIfAborted();
    const remaining = this.deadlineMs - Date.now();
    if (remaining <= 0) throw new DOMException(TIMEOUT_MESSAGE, "TimeoutError");
    return remaining;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    this.signal.throwIfAborted();
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher: this.agent,
      signal: requestSignal ? AbortSignal.any([this.signal, requestSignal]) : this.signal,
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  };

  /** Also bounds setup libraries that do not support cancellation themselves. */
  async wait<T>(work: Promise<T>): Promise<T> {
    return waitForSignal(work, this.signal);
  }

  async dispose() {
    clearTimeout(this.timer);
    this.controller.abort();
    await this.agent.destroy();
  }
}

export function executionClient(credentials: { apiKey: string; baseUrl?: string }, budget: ExecutionBudget, managedLocal = false) {
  return new OpenAI({ apiKey: credentials.apiKey,
    ...(credentials.baseUrl ? { baseURL: credentials.baseUrl } : {}),
    fetch: budget.fetch,
    timeout: budget.remainingMs(),
    // A disconnected HTTP client does not stop the worker's original generation.
    ...(managedLocal ? { maxRetries: 0 } : {}),
  });
}

export async function waitForSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let stop: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      stop = () => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    })]);
  } finally { signal.removeEventListener("abort", stop); }
}
