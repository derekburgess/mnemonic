import { test } from "node:test";
import assert from "node:assert/strict";
import { withLocalModel, localCompletion } from "../server/localModels.ts";

test("real Transformers download, load, inference and unload", { skip: !process.env.MNEMONIC_TEST_TRANSFORMERS, timeout: 1_200_000 }, async () => {
  const events: string[] = [];
  const model = "HuggingFaceTB/SmolLM2-135M-Instruct";
  await withLocalModel({ model, mode: "download", signal: AbortSignal.timeout(1_180_000), emit: (e) => { events.push(e.kind); } }, async () => {}, 0);
  const result = await withLocalModel({ model,
    signal: AbortSignal.timeout(1_180_000), emit: (e) => { events.push(e.kind); if (e.kind !== "local.downloading") console.log(e.kind, e.detail); } },
    ({ apiKey }) => localCompletion(apiKey, { model, messages: [{ role: "user", content: "Say hello." }], max_tokens: 8 } as any), 8787) as any;
  assert.ok(!events.slice(events.lastIndexOf("local.queued")).includes("local.downloading"), "inference must not download or access the Hub");
  assert.ok(result.choices[0].message.content);
  assert.ok(events.includes("local.unloaded"));
});
