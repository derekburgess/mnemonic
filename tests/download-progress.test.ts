import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("download byte reports work without terminal counters, including resume and final flush", () => {
  const result = spawnSync("python3", ["-c", `
import importlib.util
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("worker", "local-model/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class SilentBar:
    def __init__(self, **kwargs):
        self.n = kwargs.get("initial", 0)
    def update(self, n):
        pass  # tqdm does not advance n when disabled.
    def close(self):
        pass

reports = []
Progress = worker.download_progress(SilentBar, reports.append)
with patch.object(worker.time, "monotonic", return_value=1.0) as clock:
    bar = Progress(initial=100)
    assert reports == [100]
    bar.update(20)
    assert reports == [100]  # Batches updates within the reporting interval.
    clock.return_value = 1.3
    bar.update(30)
    assert reports == [100, 150]
    assert bar.n == 100  # Reports are independent of the disabled terminal counter.
    bar.update(7)
    bar.close()
    assert reports == [100, 150, 157]
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
