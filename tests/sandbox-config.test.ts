import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeSandboxConfig, resourceArgs } from "../src/sandboxConfig.ts";

test("sandbox defaults remain compatible and resource values are left to Docker", () => {
  assert.deepEqual(resourceArgs(runtimeSandboxConfig().sandbox), ["--memory=2g", "--cpus=2", "--pids-limit=512"]);
  const config = runtimeSandboxConfig(JSON.stringify({ sandbox: { memory: "not-a-memory-limit", cpus: null }, localModel: { memory: "8g", cpus: 4 } }));
  assert.deepEqual(resourceArgs(config.sandbox), ["--memory=not-a-memory-limit", "--pids-limit=512"]);
  assert.deepEqual(resourceArgs(config.localModel), ["--memory=8g", "--cpus=4", "--pids-limit=256"]);
});

test("configuration cannot inject extra Docker flags or weaken fixed isolation", () => {
  for (const config of [{ privileged: true }, { sandbox: { mounts: ["/:/host"] } }, { localModel: { network: "host" } }, { sandbox: { network: "host" } }]) {
    assert.throws(() => runtimeSandboxConfig(JSON.stringify(config)), /Unsupported|not allowed/);
  }
  assert.deepEqual(resourceArgs({ memory: "2g --privileged", cpus: null, pidsLimit: null }), ["--memory=2g --privileged"]);
  assert.throws(() => runtimeSandboxConfig("[1]"), /object/);
});
