import type OpenAI from "openai";
import type { Dispatch } from "./tools.js";
import { resolveLinks, type ResolvedLink } from "./links.js";

/**
 * How many times the model may come back asking for more tools. Agentic sequences legitimately
 * run long, so this is a per-step parameter; the cap only exists to stop a model that never
 * settles from burning tokens forever.
 */
export const DEFAULT_TOOL_ROUNDS = 12;

export type ToolCallRecord = { name: string; detail?: string; urls?: string[] };

export type RunFile = { name: string; mime: string; dataUrl: string };

const isImage = (f: RunFile) => f.mime.startsWith("image/");
const isPdf = (f: RunFile) => f.mime === "application/pdf" || /\.pdf$/i.test(f.name);

/** Anything that is neither an image nor a PDF is inlined as text, which every model accepts. */
function inlineText(files: RunFile[]): string {
  return files
    .filter((f) => !isImage(f) && !isPdf(f))
    .map((f) => {
      const base64 = f.dataUrl.slice(f.dataUrl.indexOf(",") + 1);
      const text = Buffer.from(base64, "base64").toString("utf8").trim();
      return text ? `<file name="${f.name}">\n${text}\n</file>` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Base64 payloads would otherwise be written to the trace database once per round. The trace
 * keeps the shape of the request, not megabytes of the same attachment repeated.
 */
function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.startsWith("data:") && value.length > 128
      ? `${value.slice(0, value.indexOf(",") + 1)}…${value.length} chars elided`
      : value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

export type RunArgs = {
  client: OpenAI;
  model: string;
  effort?: string;
  input: string;
  instructions?: string;
  /** Responses-shaped tool definitions, as built by buildTools. */
  tools: unknown[];
  dispatch: Dispatch;
  /** Called with each request/response pair so the trace keeps the whole loop. */
  onRound: (round: { request: unknown; response: unknown; ms: number }) => void;
  maxRounds?: number;
  /** Bounds the whole step, so an abandoned run stops costing tokens here too. */
  signal?: AbortSignal;
  files?: RunFile[];
  links?: string[];
};

export type RunResult = {
  text: string;
  model: string;
  usage: { input: number; output: number };
  toolCalls: ToolCallRecord[];
};

const uniq = (urls: (string | null | undefined)[]) => [...new Set(urls.filter((u): u is string => !!u))];

export const TIMEOUT_MESSAGE = 'The step hit its timeout. Raise "Timeout" if it legitimately takes longer.';

/**
 * Stops waiting on a tool once the step's budget is spent. The tool itself cannot be killed
 * mid-flight, but the run gives up on it rather than sitting there until it finishes.
 */
function withDeadline<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new Error(TIMEOUT_MESSAGE));
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error(TIMEOUT_MESSAGE)), { once: true }),
    ),
  ]);
}

/**
 * The Responses API: OpenAI's own surface. Carries the built-in web_search tool and returns
 * reasoning items, which is why it stays the default rather than being replaced.
 */
/** Fetched pages become text appended to the input; media is referenced by URL. */
function linkText(links: ResolvedLink[]): string {
  return links
    .filter((l) => l.kind === "text" || l.kind === "error")
    .map((l) =>
      l.kind === "error"
        ? `<link href="${l.url}" error="${l.text}" />`
        : `<link href="${l.url}">\n${l.text}\n</link>`,
    )
    .join("\n\n");
}

export async function runResponses(args: RunArgs): Promise<RunResult> {
  const { client, model, effort, input, instructions, tools, dispatch, onRound } = args;
  const maxRounds = args.maxRounds ?? DEFAULT_TOOL_ROUNDS;

  const base = {
    model,
    ...(instructions?.trim() ? { instructions } : {}),
    // Non-reasoning models reject the reasoning block outright, so only send it when asked for.
    ...(effort && effort !== "off" ? { reasoning: { effort } } : {}),
    ...(tools.length ? { tools } : {}),
  };

  const call = async (payload: Record<string, unknown>) => {
    const started = Date.now();
    const result = await client.responses.create(payload as never, { signal: args.signal });
    onRound({
      request: redact(payload),
      response: { output: result.output, usage: result.usage, model: result.model },
      ms: Date.now() - started,
    });
    return result;
  };

  const files = args.files ?? [];
  const links = args.links?.length ? await resolveLinks(args.links) : [];
  const text = [input, inlineText(files), linkText(links)].filter(Boolean).join("\n\n");

  const attached = files.filter((f) => isImage(f) || isPdf(f));
  const linkedMedia = links.filter((l) => l.kind === "image" || l.kind === "pdf");

  const userContent =
    attached.length || linkedMedia.length
      ? [
          { type: "input_text", text },
          ...attached.map((f) =>
            isImage(f)
              ? { type: "input_image", image_url: f.dataUrl, detail: "auto" }
              : { type: "input_file", filename: f.name, file_data: f.dataUrl },
          ),
          ...linkedMedia.map((l) =>
            l.kind === "image"
              ? { type: "input_image", image_url: l.dataUrl, detail: "auto" }
              : { type: "input_file", filename: l.name, file_data: l.dataUrl },
          ),
        ]
      : text;

  let conversation: unknown[] = [{ role: "user", content: userContent }];
  let response = await call({ ...base, input: conversation });

  const toolCalls: ToolCallRecord[] = [];
  let usedIn = 0;
  let usedOut = 0;

  for (let round = 0; round <= maxRounds; round++) {
    usedIn += response.usage?.input_tokens ?? 0;
    usedOut += response.usage?.output_tokens ?? 0;

    for (const item of response.output) {
      if (item.type !== "web_search_call") continue;
      const action = (item as {
        action?: { type?: string; query?: string; queries?: string[] | null; url?: string | null; sources?: { url?: string }[] | null };
      }).action;
      const detail = action?.queries?.length ? action.queries.join(" · ") : action?.query;
      const urls = uniq([action?.url, ...(action?.sources ?? []).map((src) => src.url)]);
      toolCalls.push({
        name: `web_search${action?.type && action.type !== "search" ? `.${action.type}` : ""}`,
        detail,
        ...(urls.length ? { urls } : {}),
      });
    }

    const calls = response.output.filter((o) => o.type === "function_call");
    if (!calls.length) break;
    if (round === maxRounds) {
      throw new Error(
        `The model was still requesting tools after ${maxRounds} rounds. Raise this step's ` +
          `"Rounds" if the task legitimately needs more.`,
      );
    }

    // Reasoning items must be carried forward alongside the calls they belong to.
    conversation = [...conversation, ...response.output];

    for (const call of calls) {
      const { name, arguments: callArgs, call_id } = call as unknown as {
        name: string;
        arguments: string;
        call_id: string;
      };
      toolCalls.push({ name, detail: callArgs && callArgs !== "{}" ? callArgs : undefined });
      conversation.push({
        type: "function_call_output",
        call_id,
        output: await withDeadline(dispatch(name, callArgs), args.signal),
      });
    }

    response = await call({ ...base, input: conversation });
  }

  const cited = uniq(
    response.output.flatMap((item) =>
      item.type === "message"
        ? item.content.flatMap((part) =>
            "annotations" in part
              ? (part.annotations ?? []).map((a) => (a.type === "url_citation" ? a.url : undefined))
              : [],
          )
        : [],
    ),
  );
  if (cited.length) toolCalls.push({ name: "citations", urls: cited });

  return {
    text: response.output_text ?? "",
    model: response.model ?? model,
    usage: { input: usedIn, output: usedOut },
    toolCalls,
  };
}

/** Responses tool definitions rendered in the shape Chat Completions expects. */
function asChatTools(tools: unknown[]) {
  return tools.map((tool) => {
    const t = tool as { type: string; name?: string; description?: string; parameters?: unknown };
    if (t.type !== "function") {
      throw new Error(
        `The "${t.type}" tool is built into OpenAI's Responses API and cannot be used with an ` +
          `OpenAI-compatible provider. Remove it from the step, or switch the provider to OpenAI.`,
      );
    }
    return {
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    };
  });
}

/**
 * Chat Completions: the surface every OpenAI-compatible provider speaks — OpenRouter, vLLM,
 * Ollama, LM Studio. Function calling is universal, so MCP and custom tools work unchanged;
 * built-in tools and reasoning items do not exist here.
 */
export async function runChat(args: RunArgs): Promise<RunResult> {
  const { client, model, effort, input, instructions, tools, dispatch, onRound } = args;
  const maxRounds = args.maxRounds ?? DEFAULT_TOOL_ROUNDS;

  const chatTools = tools.length ? asChatTools(tools) : undefined;
  const files = args.files ?? [];
  const links = args.links?.length ? await resolveLinks(args.links) : [];
  const text = [input, inlineText(files), linkText(links)].filter(Boolean).join("\n\n");

  const attached = files.filter((f) => isImage(f) || isPdf(f));
  const linkedImages = links.filter((l) => l.kind === "image");

  const userContent =
    attached.length || linkedImages.length
      ? [
          { type: "text", text },
          ...attached.map((f) =>
            isImage(f)
              ? { type: "image_url", image_url: { url: f.dataUrl } }
              : { type: "file", file: { filename: f.name, file_data: f.dataUrl } },
          ),
          ...linkedImages.map((l) => ({ type: "image_url", image_url: { url: l.dataUrl } })),
        ]
      : text;

  const messages: unknown[] = [
    ...(instructions?.trim() ? [{ role: "system", content: instructions }] : []),
    { role: "user", content: userContent },
  ];

  const base = {
    model,
    ...(effort && effort !== "off" ? { reasoning_effort: effort } : {}),
    ...(chatTools ? { tools: chatTools } : {}),
  };

  const call = async (payload: Record<string, unknown>) => {
    const started = Date.now();
    const result = await client.chat.completions.create(payload as never, { signal: args.signal });
    onRound({
      request: redact(payload),
      response: { choices: result.choices, usage: result.usage, model: result.model },
      ms: Date.now() - started,
    });
    return result;
  };

  let response = await call({ ...base, messages });
  const toolCalls: ToolCallRecord[] = [];
  let usedIn = 0;
  let usedOut = 0;

  for (let round = 0; round <= maxRounds; round++) {
    usedIn += response.usage?.prompt_tokens ?? 0;
    usedOut += response.usage?.completion_tokens ?? 0;

    const message = response.choices[0]?.message;
    const calls = message?.tool_calls ?? [];
    if (!calls.length) break;
    if (round === maxRounds) {
      throw new Error(
        `The model was still requesting tools after ${maxRounds} rounds. Raise this step's ` +
          `"Rounds" if the task legitimately needs more.`,
      );
    }

    messages.push(message);
    for (const call of calls) {
      const fn = (call as { id: string; function?: { name: string; arguments: string } }).function;
      if (!fn) continue;
      toolCalls.push({
        name: fn.name,
        detail: fn.arguments && fn.arguments !== "{}" ? fn.arguments : undefined,
      });
      messages.push({
        role: "tool",
        tool_call_id: (call as { id: string }).id,
        content: await withDeadline(dispatch(fn.name, fn.arguments), args.signal),
      });
    }

    response = await call({ ...base, messages });
  }

  return {
    text: response.choices[0]?.message?.content ?? "",
    model: response.model ?? model,
    usage: { input: usedIn, output: usedOut },
    toolCalls,
  };
}
