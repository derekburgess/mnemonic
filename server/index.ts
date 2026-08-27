import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const PORT = Number(process.env.PORT ?? 8787);
const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const MISSING_KEY = "OPENAI_API_KEY is not set. Copy .env.example to .env, add your key, and restart.";

if (!process.env.OPENAI_API_KEY) console.warn(`[mnemonic] ${MISSING_KEY}`);

// Constructed lazily: the SDK throws on a missing key, and the UI is still worth serving
// so the graph can be built and inspected before a key is in place.
let cached: OpenAI | null = null;
function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error(MISSING_KEY), { status: 401 });
  return (cached ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
}

/** Models we fall back to when the /models listing is unavailable. */
const FALLBACK_MODELS = ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4o", "gpt-4o-mini"];

/** The listing includes embeddings, audio, image and moderation models; keep the text ones. */
const isTextModel = (id: string) =>
  /^(gpt-|o[1345](-|$)|chatgpt-)/.test(id) &&
  !/(embedding|audio|realtime|transcribe|tts|image|moderation|search|dall-e)/.test(id);

app.get("/api/models", async (_req, res) => {
  try {
    const list = await getClient().models.list();
    const ids = list.data.map((m) => m.id).filter(isTextModel).sort();
    res.json({ models: ids.length ? ids : FALLBACK_MODELS });
  } catch (err) {
    console.warn("[mnemonic] model listing failed, serving fallback list:", (err as Error).message);
    res.json({ models: FALLBACK_MODELS, fallback: true });
  }
});

app.post("/api/run", async (req, res) => {
  const { model, effort, input, instructions } = req.body ?? {};
  if (typeof model !== "string" || typeof input !== "string" || !input.trim()) {
    return res.status(400).json({ error: "model and a non-empty input are required" });
  }

  try {
    const response = await getClient().responses.create({
      model,
      input,
      ...(typeof instructions === "string" && instructions.trim() ? { instructions } : {}),
      // Non-reasoning models reject the reasoning block outright, so only send it when asked for.
      ...(effort && effort !== "off" ? { reasoning: { effort } } : {}),
    });

    res.json({
      text: response.output_text ?? "",
      model: response.model ?? model,
      usage: response.usage
        ? { input: response.usage.input_tokens, output: response.usage.output_tokens }
        : undefined,
    });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    console.error("[mnemonic] run failed:", e.message);
    res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({
      error: e.message ?? "request failed",
    });
  }
});

app.listen(PORT, () => console.log(`[mnemonic] proxy listening on http://localhost:${PORT}`));
