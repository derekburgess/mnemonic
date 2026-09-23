import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("local provider keeps cloud credentials separate and supports optional authentication", async () => {
  const original = process.cwd();
  const directory = mkdtempSync(path.join(tmpdir(), "mnemonic-local-settings-"));
  try {
    process.chdir(directory);
    const { writeSettings, resolveCredentials, sandboxModelUrl } = await import("../server/settings.js");
    assert.equal(sandboxModelUrl("http://localhost:8000/v1"), "http://host.docker.internal:8000/v1");
    assert.equal(sandboxModelUrl("http://127.0.0.1:8080/v1"), "http://host.docker.internal:8080/v1");
    assert.equal(sandboxModelUrl("http://192.168.1.5:8000/v1"), "http://192.168.1.5:8000/v1");
    writeSettings({ provider: "compatible", apiKey: "cloud-secret", baseUrl: "https://example.com/v1" });
    writeSettings({ provider: "huggingface" });
    assert.equal(resolveCredentials().source, "none");
    assert.equal(resolveCredentials().baseUrl, "http://localhost:8000/v1");
    assert.notEqual(resolveCredentials().apiKey, "cloud-secret");
    writeSettings({ apiKey: "local-secret", baseUrl: "http://localhost:8080/v1" });
    assert.equal(resolveCredentials().apiKey, "local-secret");
    writeSettings({ provider: "compatible" });
    assert.equal(resolveCredentials().apiKey, "cloud-secret");
    assert.equal(resolveCredentials().baseUrl, "https://example.com/v1");
    writeSettings({ provider: "huggingface", apiKey: "" });
    assert.equal(resolveCredentials().source, "none");
    assert.equal(resolveCredentials().baseUrl, "http://localhost:8080/v1");
  } finally {
    process.chdir(original);
    rmSync(directory, { recursive: true, force: true });
  }
});
