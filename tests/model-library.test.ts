import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("model library detects complete files, rejects unsafe IDs, and protects an active cache", async () => {
  const cwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), "mnemonic-library-"));
  process.chdir(dir);
  try {
    const { listLibrary, modelDownloaded, deleteDownload, validateModelId } = await import("../server/modelLibrary.ts");
    const { acquireModel } = await import("../server/localModels.ts");
    for (const invalid of ["../secret", "/tmp/model", "org/../../data", "org/model/extra", "org\\model"]) assert.throws(() => validateModelId(invalid));
    const root = path.join(dir, "data/models/models--org--model");
    const revision = "a".repeat(40);
    await mkdir(path.join(root, "snapshots", revision), { recursive: true });
    await mkdir(path.join(root, "blobs"));
    await writeFile(path.join(root, "snapshots", revision, "config.json"), "{}");
    await writeFile(path.join(root, "blobs", "weights"), "12345");
    assert.equal(listLibrary()[0].status, "Incomplete");
    await writeFile(path.join(root, ".mnemonic-ready.json"), JSON.stringify({ model: "org/model", revision, files: [{ name: "config.json", size: 2 }] }));
    assert.equal(modelDownloaded("org/model"), true);
    assert.equal(listLibrary()[0].bytes, 5);
    const release = await acquireModel(new AbortController().signal);
    await assert.rejects(deleteDownload("org/model"), /in use/);
    assert.ok(await stat(root));
    release();
    await writeFile(path.join(root, "snapshots", revision, "config.json"), "corrupt");
    assert.equal(modelDownloaded("org/model"), false);
    await deleteDownload("org/model");
    assert.deepEqual(listLibrary(), []);
    await assert.rejects(stat(root), { code: "ENOENT" });
  } finally { process.chdir(cwd); await rm(dir, { recursive: true, force: true }); }
});
