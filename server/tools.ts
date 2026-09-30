import type { WorkspaceToolSettings } from "../src/toolSettings.js";
import { event, errorDetail, type EmitEvent } from "./events.js";
import vm from "node:vm";
import type { ExecutionBudget } from "./execution.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildWorkspaceTools } from "./workspace.js";

/** A tool node as the browser describes it. */
export type ToolSpec = { enabled?: boolean } & (
  | { kind: "web_search"; contextSize?: "low" | "medium" | "high"; allowedDomains?: string }
  | {
      kind: "mcp";
      label: string;
      serverUrl: string;
      authorization?: string;
      selectedTools?: string[];
      timeoutSec?: number;
    }
  | {
      kind: "custom";
      fnName: string;
      fnDescription?: string;
      fnParameters?: string;
      fnCode?: string;
      timeoutSec?: number;
    });

/** Fallbacks for calls outside node execution (for example the settings tool browser). */
export const DEFAULT_CODE_TIMEOUT_SEC = 5;
export const DEFAULT_MCP_TIMEOUT_SEC = 300;

/** A tool may opt into a shorter limit, but never extend the node's deadline. */
const mcpCallOptions = (timeoutSec?: number, budget?: ExecutionBudget) => {
  const timeout = Math.max(1, Math.min(timeoutSec !== undefined ? timeoutSec * 1000 : Infinity,
    budget?.remainingMs() ?? DEFAULT_MCP_TIMEOUT_SEC * 1000));
  return { timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false, signal: budget?.signal };
};

/** MCP tool names are namespaced so two servers can expose the same tool name. */
const mcpToolName = (label: string, tool: string) =>
  `mcp_${label}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/** Where servers conventionally mount MCP when the URL given is just a host. */
const MOUNT_PATHS = ["/mcp", "/sse", "/mcp/", "/sse/"];

/** Addresses a server binds to but which are not valid destinations to connect to. */
const BIND_ONLY: Record<string, string> = { "0.0.0.0": "127.0.0.1", "[::]": "[::1]", "::": "[::1]" };


/**
 * Servers print the address they bound to ("Uvicorn running on http://0.0.0.0:8765"), which is
 * the natural thing to paste. 0.0.0.0 means "all interfaces" rather than a host, and sending it
 * as a Host header trips the DNS-rebinding checks in FastMCP and friends, which answer 421.
 */
function normaliseHost(url: URL): URL {
  const replacement = BIND_ONLY[url.hostname];
  if (!replacement) return url;
  const fixed = new URL(url.toString());
  fixed.hostname = replacement;
  return fixed;
}

function candidateUrls(serverUrl: string): URL[] {
  const url = normaliseHost(new URL(serverUrl));
  if (url.pathname !== "/" && url.pathname !== "") return [url];
  // A bare host almost never serves MCP at the root, so try the usual mounts too.
  return [url, ...MOUNT_PATHS.map((path) => new URL(path, url))];
}

/**
 * Connects with whichever HTTP transport the server actually speaks, at whichever path it is
 * mounted on. Streamable HTTP is the current transport; servers on the older HTTP+SSE one
 * answer a POST with 404, which is a signal to retry rather than a reason to give up.
 */
async function connectMcp(
  serverUrl: string,
  authorization?: string,
  emit?: EmitEvent,
  budget?: ExecutionBudget,
): Promise<{ client: Client; url: string }> {
  const requestInit = authorization ? { headers: { Authorization: authorization } } : undefined;
  const newClient = () => new Client({ name: "mnemonic", version: "0.1.0" }, { capabilities: {} });
  const failures: string[] = [];

  let attempt = 0;
  for (const url of candidateUrls(serverUrl)) {
    for (const kind of ["streamable", "sse"] as const) {
      const started = Date.now();
      emit?.(event("proxy", "tool.connection_attempt", { attempt: ++attempt, transport: kind, url: url.toString() }));
      budget?.signal.throwIfAborted();
      const client = newClient();
      try {
        // Always a fresh client: a failed connect has already torn its transport down.
        const transport =
          kind === "streamable"
            ? new StreamableHTTPClientTransport(url, { requestInit, fetch: budget?.fetch })
            : new SSEClientTransport(url, { requestInit, fetch: budget?.fetch });
        const connecting = client.connect(transport, budget ? mcpCallOptions(undefined, budget) : undefined);
        await (budget ? budget.wait(connecting) : connecting);
        emit?.(event("proxy", "tool.connected", { attempt, transport: kind, ms: Date.now() - started }));
        return { client, url: url.toString() };
      } catch (err) {
        await client.close().catch(() => {});
        budget?.signal.throwIfAborted();
        emit?.(event("proxy", "tool.connection_failed", { attempt, transport: kind, ms: Date.now() - started, error: errorDetail(err) }));
        failures.push(`${url.pathname} (${kind}): ${(err as Error).message.slice(0, 120)}`);
      }
    }
  }

  throw new Error(failures.join("; "));
}

async function withMcpClient<T>(
  serverUrl: string,
  authorization: string | undefined,
  fn: (client: Client) => Promise<T>,
  emit?: EmitEvent,
  budget?: ExecutionBudget,
): Promise<T> {
  const { client } = await connectMcp(serverUrl, authorization, emit, budget);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Also reports the URL that actually worked, so the UI can correct the one you typed. */
export async function listMcpTools(serverUrl: string, authorization?: string, emit?: EmitEvent, budget?: ExecutionBudget) {
  const { client, url } = await connectMcp(serverUrl, authorization, emit, budget);
  try {
    const { tools } = await client.listTools({}, budget ? mcpCallOptions(undefined, budget) : undefined);
    return {
      resolvedUrl: url,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema as Record<string, unknown>,
      })),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/** JSON Schema the Responses API will accept for a function tool. */
const objectSchema = (schema: unknown): Record<string, unknown> => {
  const s = (schema ?? {}) as Record<string, unknown>;
  return s.type === "object" ? s : { type: "object", properties: {}, additionalProperties: true };
};

type CallContext = { callId: string; round: number };
export type Dispatch = (name: string, args: string, context?: CallContext) => Promise<string>;

/**
 * Turn tool nodes into Responses API tool definitions, plus a dispatcher for the ones we
 * execute ourselves. web_search is server-side at OpenAI and never reaches the dispatcher.
 *
 * A step's workspaces are not tools you configure — they are folders you lend it — so the
 * file tools that reach them are derived here rather than listed under Tools.
 */
export async function buildTools(
  specs: ToolSpec[],
  workspaces: string[] = [],
  emit?: EmitEvent,
  budget?: ExecutionBudget,
  workspaceTools: WorkspaceToolSettings = {},
): Promise<{ tools: unknown[]; dispatch: Dispatch }> {
  const tools: unknown[] = [];
  const handlers = new Map<string, (args: unknown, context?: CallContext) => Promise<string>>();

  for (const [name, tool] of Object.entries(buildWorkspaceTools(workspaces))) {
    const enabled = workspaceTools[name as keyof WorkspaceToolSettings] !== false;
    emit?.(event("proxy", "tool.configured", { kind: "workspace", name, enabled }));
    if (!enabled) continue;
    tools.push(tool.definition);
    handlers.set(name, async (args) =>
      JSON.stringify(await tool.run((args ?? {}) as Record<string, unknown>)),
    );
  }

  for (const spec of specs) {
    if (spec.enabled === false) continue;
    emit?.(event("proxy", "tool.configured", { kind: spec.kind, name: spec.kind === "custom" ? spec.fnName : spec.kind === "mcp" ? spec.label : "web_search", timeoutSec: spec.kind === "web_search" ? null : spec.timeoutSec ?? (budget ? "node deadline" : spec.kind === "mcp" ? DEFAULT_MCP_TIMEOUT_SEC : DEFAULT_CODE_TIMEOUT_SEC), automaticToolRetries: 0 }));
    if (spec.kind === "web_search") {
      const domains = (spec.allowedDomains ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
      tools.push({
        type: "web_search",
        ...(spec.contextSize ? { search_context_size: spec.contextSize } : {}),
        ...(domains.length ? { filters: { allowed_domains: domains } } : {}),
      });
      continue;
    }

    if (spec.kind === "mcp") {
      // We are the MCP client, so private and localhost servers work; OpenAI only ever sees
      // ordinary function tools that call back into this proxy.
      const { tools: available } = await listMcpTools(spec.serverUrl, spec.authorization, emit, budget);
      const wanted = spec.selectedTools?.length
        ? available.filter((t) => spec.selectedTools!.includes(t.name))
        : available;

      for (const tool of wanted) {
        const name = mcpToolName(spec.label, tool.name);
        tools.push({
          type: "function",
          name,
          description: tool.description || `${tool.name} on ${spec.label}`,
          parameters: objectSchema(tool.inputSchema),
          strict: false,
        });
        handlers.set(name, async (args, context) => {
          const result = await withMcpClient(spec.serverUrl, spec.authorization, (client) =>
            client.callTool(
              { name: tool.name, arguments: (args ?? {}) as Record<string, unknown> },
              undefined,
              mcpCallOptions(spec.timeoutSec, budget),
            ),
            emit ? (entry) => emit({ ...entry, detail: { ...(entry.detail as Record<string, unknown>), name, ...context } }) : undefined,
            budget,
          );
          return JSON.stringify(result.isError ? { isError: true, content: result.content } : result.content ?? result);
        });
      }
      continue;
    }

    // custom
    let parameters: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: true };
    if (spec.fnParameters?.trim()) {
      try {
        parameters = objectSchema(JSON.parse(spec.fnParameters));
      } catch {
        throw new Error(`Tool "${spec.fnName}": parameters must be valid JSON Schema`);
      }
    }

    tools.push({
      type: "function",
      name: spec.fnName,
      description: spec.fnDescription ?? "",
      parameters,
      strict: false,
    });

    handlers.set(spec.fnName, async (args) => {
      const result = await runUserCode(spec.fnCode ?? "", args, spec.timeoutSec, budget);
      return typeof result === "string" ? result : JSON.stringify(result ?? null);
    });
  }

  const dispatch: Dispatch = async (name, rawArgs, context) => {
    budget?.signal.throwIfAborted();
    const handler = handlers.get(name);
    if (!handler) return JSON.stringify({ error: `unknown tool ${name}` });
    let args: unknown = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return JSON.stringify({ error: "arguments were not valid JSON" });
    }
    try {
      const work = handler(args, context);
      return await (budget ? budget.wait(work) : work);
    } catch (err) {
      budget?.signal.throwIfAborted();
      return JSON.stringify({ error: (err as Error).message, errorDetails: errorDetail(err) });
    }
  };

  return { tools, dispatch };
}

/**
 * Runs a custom tool body with `args` in scope. node:vm is NOT a security boundary — this is
 * for code you wrote yourself on your own machine, never for untrusted input.
 */
async function runUserCode(code: string, args: unknown, timeoutSec?: number, execution?: ExecutionBudget): Promise<unknown> {
  const budget = Math.max(1, Math.ceil(Math.min(timeoutSec !== undefined ? timeoutSec * 1000 : Infinity,
    execution?.remainingMs() ?? DEFAULT_CODE_TIMEOUT_SEC * 1000)));
  const controller = new AbortController();
  const signal = execution ? AbortSignal.any([execution.signal, controller.signal]) : controller.signal;
  const timers = new Set<NodeJS.Timeout>();
  const transport = execution?.fetch ?? fetch;
  // A fresh vm context has the JS built-ins but none of Node's globals, so timers and fetch
  // have to be handed in explicitly or any async tool body fails on `setTimeout is not defined`.
  const context = vm.createContext({
    args,
    console,
    fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => transport(input, {
      ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    }),
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    setTimeout: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer = setTimeout(fn, ms, ...args); timers.add(timer); return timer;
    },
    clearTimeout,
    setInterval: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer = setInterval(fn, ms, ...args); timers.add(timer); return timer;
    },
    clearInterval,
    queueMicrotask,
    structuredClone,
    AbortController,
  });
  // The vm timeout only covers synchronous execution, so an async body is raced separately.
  let timer: NodeJS.Timeout | undefined;
  try {
    const started = vm.runInContext(`(async () => {\n${code}\n})()`, context, {
      timeout: budget,
    }) as Promise<unknown>;

    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(`tool code exceeded ${budget}ms`)); }, budget);
    });

    const work = Promise.race([started, deadline]);
    return await (execution ? execution.wait(work) : work);
  } finally {
    clearTimeout(timer);
    controller.abort();
    for (const timer of timers) clearTimeout(timer);
  }
}
