import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { waitForApi } from "../server/devReadiness.js";

test("dev readiness waits for the API, not just an open port", async (t) => {
  let attempts = 0;
  const server = createServer((req, res) => {
    assert.equal(req.url, "/api/health");
    attempts++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(attempts < 3 ? { service: "other" } : { service: "mnemonic", status: "ready" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as {port: number}).port;
  await waitForApi(`http://127.0.0.1:${port}`, 2000, 10);
  assert.equal(attempts, 3);
});

test("dev readiness gives an actionable timeout when the API is unavailable", async (t) => {
  const server = createServer((_req, res) => { res.writeHead(503); res.end('{}'); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as {port: number}).port;
  await assert.rejects(waitForApi(`http://127.0.0.1:${port}`, 60, 10), /did not become ready.*server.*PORT/);
});
