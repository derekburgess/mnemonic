import { test, expect, type Page } from "@playwright/test";

function seed(outputs = 1) {
  return { nodes: [{ id: "step", type: "step", position: { x: 0, y: 0 }, data: {
    label: "Step 1", model: "test", effort: "off", prompt: "Make an output", outputs, status: "idle", timeoutSec: 30,
  } }], edges: [], updatedMs: 1 };
}
async function setup(page: Page, outputs = 1) {
  const state = { graph: seed(outputs) as any, complete: false, partial: false, offline: false,
    cancelled: new Set<string>(), executions: [] as any[] };
  await page.addInitScript((graph) => {
    if (!localStorage.getItem("mnemonic.graph.v1")) {
      localStorage.setItem("mnemonic.graph.v1", JSON.stringify({ nodes: graph.nodes, edges: graph.edges }));
      localStorage.setItem("mnemonic.graph.sync.v1", JSON.stringify({ revision: 1, dirty: false }));
    }
  }, state.graph);
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const url = new URL(req.url()); const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/local-model/models") return json({ models: [], activity: null });
    if (path === "/api/models") return json({ models: ["test"] });
    if (path === "/api/sandbox") return json({ available: true });
    if (path === "/api/graph") {
      if (state.offline) return route.abort("failed");
      if (req.method() === "GET") return json(state.graph);
      const body = req.postDataJSON();
      if (body.expectedRevision !== state.graph.updatedMs) return json({ error: "Newer saved graph" }, 409);
      state.graph = { nodes: body.nodes, edges: body.edges, updatedMs: state.graph.updatedMs + 1 };
      return json({ updatedMs: state.graph.updatedMs });
    }
    if (path === "/api/run") {
      const body = req.postDataJSON();
      if (!state.executions.some((e) => e.trace.execId === body.trace.execId)) state.executions.push(body);
      return json({ runId: body.trace.runId, execId: body.trace.execId, status: "accepted" }, 202);
    }
    if (path.endsWith("/cancel")) { state.cancelled.add(path.split("/").at(-2)!); return json({ cancelling: true }); }
    if (path.startsWith("/api/executions/")) {
      const id = path.split("/").at(-1)!;
      if (state.cancelled.has(id)) return json({ status: "error", error: "cancelled" });
      if (!state.complete) return json({ status: "pending" });
      if (state.partial && state.executions[1]?.trace.execId === id) return json({ status: "error", error: "Second generation failed" });
      return json({ status: "ok", text: "Recovered output", model: "test" });
    }
    if (path === "/api/trace/events") return json({ ok: true });
    if (path === "/api/trace/runs") return json({ runs: state.executions.length ? [{ runId: state.executions[0].trace.runId,
      kind: "run", startedMs: Date.now(), finishedMs: Date.now(), steps: state.executions.length, errors: 0, models: "test" }] : [] });
    const steps = state.executions.map((e) => ({ ...e.trace, requestedModel: "test", servedModel: "test", effort: "off",
      startedMs: Date.now(), finishedMs: Date.now(), status: "ok", outputText: "Recovered output", inputPrompt: "test",
      events: [], delivery: "awaiting delivery", rounds: [], tools: [], toolCalls: [], files: [], links: [], params: {}, error: null }));
    if (path.endsWith("/progress")) return json({ cursor: 0, events: [], steps });
    if (path.startsWith("/api/trace/runs/")) return json({ steps });
    return json({});
  });
  await page.goto("/");
  await expect(page.locator(".save-status")).toHaveText("Saved");
  return state;
}

test("refresh recovers pending output exactly once", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect.poll(() => state.executions.length).toBe(1);
  await page.reload();
  state.complete = true;
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(1);
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.reload();
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(1);
  expect(state.executions.length).toBe(1);
});

test("cancellation stops the server execution and creates no output", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect.poll(() => state.executions.length).toBe(1);
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect.poll(() => state.cancelled.size).toBe(1);
  state.complete = true;
  await expect(page.getByRole("button", { name: "Run all", exact: true })).toBeVisible();
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(0);
});

test("a completed output survives refresh before graph autosave succeeds", async ({ page }) => {
  const state = await setup(page);
  state.complete = true; state.offline = true;
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(1);
  state.offline = false;
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
  expect(state.graph.nodes.filter((n: any) => n.type === "artifact")).toHaveLength(1);
});

test("partial fan-out keeps the successful output", async ({ page }) => {
  const state = await setup(page, 2); state.complete = true; state.partial = true;
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(1);
  await expect(page.getByText(/1 of 2 generations failed/)).toBeVisible();
});

test("saved trace output can be added manually without duplicates", async ({ page }) => {
  const state = await setup(page);
  state.executions.push({ trace: { runId: "history", execId: "saved", nodeId: "step", label: "Step 1", seq: 0, context: [] } });
  await page.getByRole("button", { name: "Trace Logs" }).click();
  await page.locator(".trace-run-head .trace-toggle").click();
  await page.locator(".trace-step > .trace-toggle").click();
  await page.getByRole("button", { name: "Add saved output to graph" }).click();
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Already on graph" })).toBeDisabled();
});

test("offline saves retry and clear cached-only status", async ({ page }) => {
  const state = await setup(page); state.offline = true;
  await page.getByRole("textbox", { name: "Step name" }).fill("Offline edit");
  await expect(page.locator(".save-status")).toHaveText("Cached locally");
  state.offline = false;
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
  expect(state.graph.nodes[0].data.label).toBe("Offline edit");
});

test("a newer remote revision cannot overwrite local edits silently", async ({ page }) => {
  const state = await setup(page);
  state.graph = { ...state.graph, updatedMs: state.graph.updatedMs + 10 };
  await page.getByRole("textbox", { name: "Step name" }).fill("Local branch");
  await expect(page.getByRole("button", { name: "Keep local edits" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Step name" })).toHaveValue("Local branch");
  await page.getByRole("button", { name: "Keep local edits" }).click();
  await expect(page.locator(".save-status")).toHaveText("Saved");
  expect(state.graph.nodes[0].data.label).toBe("Local branch");
});

test("local models force container switches on and unlock them when disabled", async ({ page }) => {
  await setup(page);
  let settings = { provider: "huggingface", runLocally: true, keySource: "none", baseUrl: "", hasPanelKey: false };
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "POST") settings = { ...settings, ...route.request().postDataJSON() };
    await route.fulfill({ json: { ...settings, providers: [{ ...settings, configured: true }] } });
  });
  await page.reload();
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("huggingface");
  const switches = page.getByRole("checkbox", { name: "Run in a sandbox" });
  await expect(switches.first()).toBeChecked();
  await expect(switches.first()).toBeDisabled();
  await page.getByRole("button", { name: "Add Step", exact: true }).click();
  await expect(switches).toHaveCount(2);
  await expect(switches.nth(1)).toBeChecked();
  await expect(switches.nth(1)).toBeDisabled();
  const gpu = page.getByRole("checkbox", { name: "Use GPU", exact: true });
  await expect(gpu).toHaveCount(2);
  await expect(gpu.first()).not.toBeChecked();
  await gpu.first().press("Space");
  await expect(gpu.first()).toBeChecked();
  await expect(gpu.nth(1)).not.toBeChecked();
  await expect(page.locator(".sandbox-controls").first().getByRole("checkbox")).toHaveCount(2);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Download and run models locally" }).press("Space");

  await expect(page.getByRole("region", { name: "Downloaded models" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /Base URL/ })).toBeVisible();
  await expect(switches.first()).toBeEnabled();
  await expect(switches.first()).not.toBeChecked();
});

test("Hugging Face library downloads before runs, shows progress, and deletes cached models", async ({ page }) => {
  await setup(page);
  let models: any[] = [];
  await page.route("**/api/models*", (route) => route.fulfill({ json: { models: models.filter((m) => m.status === "Downloaded").map((m) => m.model) } }));
  await page.route("**/api/settings", (route) => route.fulfill({ json: { provider: "huggingface", runLocally: true,
    keySource: "none", hasPanelKey: false, baseUrl: "", providers: [{ provider: "huggingface", runLocally: true, configured: true }] } }));
  await page.route("**/api/local-model/**", async (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    if (endpoint.endsWith("/download")) {
      expect(route.request().postDataJSON().model).toBe("org/model");
      models = [{ model: "org/model", status: "Downloading", active: true, bytes: 0, downloaded: 50, total: 100 }];
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    if (route.request().method() === "DELETE") { models = []; return route.fulfill({ json: { deleted: true } }); }
    return route.fulfill({ json: { models, activity: models.some((m) => m.active) ? { model: "org/model", phase: "Downloading", downloaded: 50, total: 100 } : null } });
  });
  await page.reload();
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("huggingface");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const library = page.getByRole("region", { name: "Downloaded models" });
  await library.getByRole("textbox", { name: "Hugging Face model ID" }).fill("org/model");
  await library.getByRole("button", { name: "Download", exact: true }).click();
  await expect(library.getByRole("progressbar")).toHaveAttribute("value", "50");
  await expect(library.getByRole("button", { name: "Cancel download" })).toBeVisible();
  await expect(library.getByRole("checkbox", { name: "Use GPU" })).toHaveCount(0);
  models = [{ model: "org/model", status: "Downloaded", active: false, bytes: 1048576 }];
  await expect(library.getByText("Downloaded · 1 MB cached")).toBeVisible();
  await expect(library.getByRole("checkbox", { name: "Use GPU" })).toHaveCount(0);
  const modelSelect = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(modelSelect).toBeVisible();
  await modelSelect.selectOption("org/model");
  await expect(modelSelect).toHaveValue("org/model");
  await library.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(library.getByText("No local models downloaded yet.")).toBeVisible();
});

test("tagged thinking appears between the step and answer with visible tags", async ({ page }) => {
  await setup(page);
  await page.route("**/api/executions/**", (route) => route.fulfill({ json: {
    status: "ok", text: "<think>Keep these tags.</think>\n\nHello!", model: "test",
  } }));
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  const artifacts = page.locator(".react-flow__node-artifact");
  await expect(artifacts).toHaveCount(2);
  const thinking = artifacts.filter({ hasText: "<think>Keep these tags.</think>" });
  await expect(thinking.locator(".node-head strong")).toHaveText("test");
  await expect(thinking.locator(".text")).toHaveText("<think>Keep these tags.</think>");
  const answer = artifacts.filter({ has: page.getByText("Hello!", { exact: true }) });
  await expect(answer.locator(".text")).toHaveText("Hello!");
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.reload();
  await expect(artifacts).toHaveCount(2);
  await expect(thinking.locator(".text")).toHaveText("<think>Keep these tags.</think>");
});

test("node provider selection filters models, persists, and routes execution", async ({ page }) => {
  const state = await setup(page);
  await page.route("**/api/settings*", (route) => route.fulfill({ json: {
    provider: "openai", keySource: "panel", baseUrl: "", hasPanelKey: true,
    providers: [
      { provider: "openai", configured: true, keySource: "panel" },
      { provider: "compatible", configured: true, keySource: "panel" },
      { provider: "huggingface", configured: false, keySource: "none" },
    ],
  } }));
  await page.route("**/api/models*", (route) => route.fulfill({ json: {
    models: new URL(route.request().url()).searchParams.get("provider") === "compatible" ? ["local-model"] : ["test"],
  } }));
  await page.reload();
  const node = page.locator(".react-flow__node-step").first();
  const provider = node.getByRole("combobox", { name: "Provider", exact: true });
  await expect(provider.locator("option")).toHaveCount(2);
  await provider.selectOption("compatible");
  await expect(node.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("local-model");
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.reload();
  await expect(provider).toHaveValue("compatible");
  await page.getByRole("button", { name: "Add Step", exact: true }).click();
  const second = page.locator(".react-flow__node-step").nth(1);
  await expect(second.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue("openai");
  await second.locator("textarea.prompt").fill("Another provider");
  state.complete = true;
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect.poll(() => state.executions.length).toBe(2);
  expect(state.executions.map((e) => [e.provider, e.model])).toEqual([
    ["compatible", "local-model"], ["openai", "test"],
  ]);
});

test("sandbox status uses trace events, matches the toggle, and preserves completion across reload", async ({ page }, testInfo) => {
  const state = await setup(page);
  const events: any[] = [];
  let polls = 0;
  let finishedMs: number | null = null;
  await page.route("**/api/trace/runs/*/progress*", (route) => {
    polls++;
    const after = Number(new URL(route.request().url()).searchParams.get("after"));
    return route.fulfill({ json: { cursor: events.length, events: events.filter((e) => e.order > after),
      steps: state.executions.map((e) => ({ execId: e.trace.execId, status: state.complete ? "ok" : "running", error: null, finishedMs })) } });
  });
  const status = page.getByRole("status", { name: "Sandbox status" });
  await expect(status).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Run in a sandbox" }).press("Space");
  await expect(status).toHaveText("Ready to run in a sandbox");
  await page.getByRole("textbox", { name: "Step name" }).focus();
  const node = page.locator(".react-flow__node-step");
  const styles = await node.evaluate((element) => {
    const toggle = element.querySelector(".sandbox-controls")!;
    const block = element.querySelector(".sandbox-status")!;
    const shell = (el: Element) => {
      const css = getComputedStyle(el);
      return [css.backgroundColor, css.borderColor, css.borderRadius, css.padding];
    };
    return { toggle: shell(toggle), block: shell(block), cursor: getComputedStyle(block).cursor,
      afterToggle: !!(toggle.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING),
      beforeWorkspace: !!(block.compareDocumentPosition(element.querySelector("button.attach")!) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  expect(styles.block).toEqual(styles.toggle);
  expect(styles.cursor).toBe("default");
  expect(styles.afterToggle && styles.beforeWorkspace).toBe(true);
  await node.getByRole("button", { name: "Run step" }).click();
  await expect.poll(() => state.executions.length).toBe(1);
  const emit = (kind: string, detail = {}) => events.push({ kind, detail, id: String(events.length),
    order: events.length + 1, at: Date.now(), execId: state.executions[0].trace.execId, source: "proxy" });
  emit("image.build_started");
  await expect(status).toHaveText("Building sandbox image");
  emit("execution.budget", { timeoutSec: 900, deadlineMs: Date.now() + 650000 });
  emit("model.started", { round: 2 });
  emit("delivery.poll");
  await expect(status).toHaveText("Generating response · round 2");
  await node.screenshot({ path: testInfo.outputPath("sandbox-status.png") });
  const timing = page.getByLabel("Elapsed time and timeout budget");
  await expect(timing).toContainText("/ 15m");
  const initialTime = await timing.textContent();
  await expect(timing).not.toHaveText(initialTime!);
  emit("tool.started", { name: "read_file" });
  await expect(status).toHaveText("Running tool: read_file");
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.reload();
  await expect(status).toHaveText("Running tool: read_file");
  emit("runner.completed");
  await expect(status).toHaveText("Cleaning up containers");
  state.complete = true;
  finishedMs = Date.now();
  await expect(status).toHaveText("Completed");
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(1);
  const finalTime = await timing.textContent();
  const finalPolls = polls;
  await page.waitForTimeout(1200);
  await expect(timing).toHaveText(finalTime!);
  expect(polls).toBe(finalPolls);
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.reload();
  await expect(status).toHaveText("Completed");
  state.complete = false;
  finishedMs = null;
  await node.getByRole("button", { name: "Run step" }).click();
  await expect.poll(() => state.executions.length).toBe(2);
  // The new execution's identity resets the line, even when old trace events are replayed.
  await expect(status).toHaveText("Starting execution");
});
