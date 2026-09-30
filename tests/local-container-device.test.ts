import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareModelContainer, removeModelContainer } from "../server/localModelContainer.ts";

test("downloads never request a GPU, even with CUDA configured or an NVIDIA runtime detected", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemonic-device-"));
  const oldPath = process.env.PATH;
  const oldDevice = process.env.MNEMONIC_MODEL_DEVICE;
  const log = path.join(dir, "calls.jsonl");
  await writeFile(path.join(dir, "docker"), `#!/usr/bin/env python3
import json, sys
with open(${JSON.stringify(log)}, 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1] == 'info':
    print('{"nvidia": {}}')
`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    for (const device of ["auto", "cuda", "cpu"]) {
      process.env.MNEMONIC_MODEL_DEVICE = device;
      const transport = await prepareModelContainer(new AbortController().signal, () => {}, () => {}, true, true);
      await removeModelContainer(transport.name);
    }
    process.env.MNEMONIC_MODEL_DEVICE = "cuda";
    for (const useGpu of [undefined, false, true]) {
      const transport = await prepareModelContainer(new AbortController().signal, () => {}, () => {}, false, useGpu, JSON.stringify({ localModel: { memory: "8g", cpus: 4 } }));
      await removeModelContainer(transport.name);
    }
    const calls: string[][] = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const creates = calls.filter((args) => args[0] === "create");
    assert.equal(creates.length, 6);
    for (const args of creates.slice(0, 3)) {
      assert.ok(!args.includes("--gpus"));
      assert.ok(!args.includes("--network=none"));
      assert.ok(args.some((arg) => arg.endsWith("target=/models")));
    }
    assert.equal(new Set(creates.slice(0, 3).map((args) => args.at(-1))).size, 1, "all downloads use the same CPU image");
    assert.ok(!creates[3].includes("--gpus"), "inference defaults to CPU despite detected NVIDIA runtime");
    assert.ok(!creates[4].includes("--gpus"), "GPU off overrides legacy CUDA environment setting");
    for (const args of creates.slice(3)) {
      assert.ok(args.includes("--memory=8g"));
      assert.ok(args.includes("--cpus=4"));
      assert.ok(args.includes("--network=none"));
      assert.ok(args.includes("--read-only"));
      assert.ok(args.includes("--cap-drop=ALL"));
    }
    assert.ok(creates[5].includes("--gpus"), "GPU on requests Docker GPU access");
    assert.notEqual(creates[5].at(-1), creates[0].at(-1), "GPU inference uses the CUDA image");
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldDevice === undefined) delete process.env.MNEMONIC_MODEL_DEVICE; else process.env.MNEMONIC_MODEL_DEVICE = oldDevice;
    await rm(dir, { recursive: true, force: true });
  }
});
