/** How long to wait for a page, and how much of it to keep. */
const FETCH_TIMEOUT_MS = 20_000;
const MAX_CHARS = 200_000;

export type ResolvedLink =
  | { kind: "image"; url: string; dataUrl: string }
  | { kind: "pdf"; url: string; name: string; dataUrl: string }
  | { kind: "text"; url: string; text: string }
  | { kind: "error"; url: string; text: string };

/** Media is fetched here rather than handed over as a URL. */
const MAX_BYTES = 20 * 1024 * 1024;

const looksLike = (url: string, exts: string[]) => {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();
  return exts.some((ext) => path.endsWith(ext));
};

/** Crude but adequate: drop scripts and styles, unwrap tags, collapse whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * Everything is fetched here, including media. Handing a URL to the model means *its* servers
 * have to reach the host, which fails on anything private and on hosts that refuse unfamiliar
 * clients — Wikimedia answers OpenAI's fetcher with a 400. Fetching ourselves also means a page
 * arrives as readable text rather than markup.
 */
export async function resolveLink(url: string): Promise<ResolvedLink> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "error", url, text: "not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "error", url, text: "only http and https links are supported" };
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // Some hosts refuse requests without a recognisable browser user agent.
        "user-agent": "Mozilla/5.0 (compatible; mnemonic/0.1)",
        accept: "text/html,text/plain,image/*,application/pdf;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) return { kind: "error", url, text: `fetch failed with ${res.status}` };

    // The extension is only a hint; the response tells us what it actually is.
    const type = res.headers.get("content-type") ?? "";
    const isImage = type.startsWith("image/") || looksLike(url, [".png", ".jpg", ".jpeg", ".gif", ".webp"]);
    const isPdf = type.includes("pdf") || looksLike(url, [".pdf"]);

    if (isImage || isPdf) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) {
        return { kind: "error", url, text: `file is larger than ${MAX_BYTES / 1024 / 1024}MB` };
      }
      const mime = type.split(";")[0] || (isPdf ? "application/pdf" : "image/png");
      const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
      return isPdf
        ? { kind: "pdf", url, name: new URL(url).pathname.split("/").pop() || "document.pdf", dataUrl }
        : { kind: "image", url, dataUrl };
    }

    const body = await res.text();
    const text = type.includes("html") ? htmlToText(body) : body.trim();
    return {
      kind: "text",
      url,
      text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… truncated` : text,
    };
  } catch (err) {
    return { kind: "error", url, text: (err as Error).message };
  }
}

export const resolveLinks = (urls: string[]) => Promise.all(urls.map(resolveLink));
