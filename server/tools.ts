import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** A tool node as the browser describes it. */
export type ToolSpec =
  | { kind: "web_search"; contextSize?: "low" | "medium" | "high"; allowedDomains?: string }
  | { kind: "mcp"; label: string; serverUrl: string; authorization?: string; selectedTools?: string[] }
  | {
      kind: "custom";
      fnName: string;
      fnDescription?: string;
      fnParameters?: string;
      fnCode?: string;
    };

export const CODE_TIMEOUT_MS = 5000;

/** MCP tool names are namespaced so two servers can expose the same tool name. */
const mcpToolName = (label: string, tool: string) =>
  `mcp_${label}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

async function withMcpClient<T>(
  serverUrl: string,
  authorization: string | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: authorization ? { headers: { Authorization: authorization } } : undefined,
  });
  const client = new Client({ name: "mnemonic", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function listMcpTools(serverUrl: string, authorization?: string) {
  return withMcpClient(serverUrl, authorization, async (client) => {
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  });
}

/** JSON Schema the Responses API will accept for a function tool. */
const objectSchema = (schema: unknown): Record<string, unknown> => {
  const s = (schema ?? {}) as Record<string, unknown>;
  return s.type === "object" ? s : { type: "object", properties: {}, additionalProperties: true };
};

export type Dispatch = (name: string, args: string) => Promise<string>;

/**
 * Turn tool nodes into Responses API tool definitions, plus a dispatcher for the ones we
 * execute ourselves. web_search is server-side at OpenAI and never reaches the dispatcher.
 */
export async function buildTools(specs: ToolSpec[]): Promise<{ tools: unknown[]; dispatch: Dispatch }> {
  const tools: unknown[] = [];
  const handlers = new Map<string, (args: unknown) => Promise<string>>();

  for (const spec of specs) {
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
      const available = await listMcpTools(spec.serverUrl, spec.authorization);
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
        handlers.set(name, async (args) => {
          const result = await withMcpClient(spec.serverUrl, spec.authorization, (client) =>
            client.callTool({ name: tool.name, arguments: (args ?? {}) as Record<string, unknown> }),
          );
          return JSON.stringify(result.content ?? result);
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
      const result = await runUserCode(spec.fnCode ?? "", args);
      return typeof result === "string" ? result : JSON.stringify(result ?? null);
    });
  }

  const dispatch: Dispatch = async (name, rawArgs) => {
    const handler = handlers.get(name);
    if (!handler) return JSON.stringify({ error: `unknown tool ${name}` });
    let args: unknown = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return JSON.stringify({ error: "arguments were not valid JSON" });
    }
    try {
      return await handler(args);
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message });
    }
  };

  return { tools, dispatch };
}

/**
 * Runs a custom tool body with `args` in scope. node:vm is NOT a security boundary — this is
 * for code you wrote yourself on your own machine, never for untrusted input.
 */
async function runUserCode(code: string, args: unknown): Promise<unknown> {
  const context = vm.createContext({ args, console, fetch, URL, TextDecoder, TextEncoder });
  // The vm timeout only covers synchronous execution, so an async body is raced separately.
  const started = vm.runInContext(`(async () => {\n${code}\n})()`, context, {
    timeout: CODE_TIMEOUT_MS,
  }) as Promise<unknown>;

  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool code exceeded ${CODE_TIMEOUT_MS}ms`)), CODE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([started, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
