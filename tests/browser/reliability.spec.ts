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
  await page.route("**/api/settings*", async (route) => {
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
  await page.locator(".provider-settings > summary").filter({ hasText: "Hugging Face" }).click();
  await page.getByRole("checkbox", { name: "Download and run models locally" }).press("Space");

  await expect(page.getByRole("region", { name: "Downloaded models" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Hugging Face settings" }).getByRole("textbox", { name: /Base URL/ })).toBeVisible();
  await expect(switches.first()).toBeEnabled();
  await expect(switches.first()).not.toBeChecked();
});

test("Hugging Face library downloads before runs, shows progress, and deletes cached models", async ({ page }) => {
  await setup(page);
  let models: any[] = [];
  await page.route("**/api/models*", (route) => route.fulfill({ json: { models: models.filter((m) => m.status === "Downloaded").map((m) => m.model) } }));
  await page.route("**/api/settings*", (route) => route.fulfill({ json: { provider: "huggingface", runLocally: true,
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
  await page.locator(".provider-settings > summary").filter({ hasText: "Hugging Face" }).click();
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
  await page.setViewportSize({ width: 1600, height: 1800 });
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
      afterTools: !!(element.querySelector(".tools")!.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  expect(styles.block).toEqual(styles.toggle);
  expect(styles.cursor).toBe("default");
  expect(styles.afterToggle && styles.afterTools).toBe(true);
  await node.getByRole("button", { name: "Run step" }).click();
  await expect.poll(() => state.executions.length).toBe(1);
  const emit = (kind: string, detail = {}) => events.push({ kind, detail, id: String(events.length),
    order: events.length + 1, at: Date.now(), execId: state.executions[0].trace.execId, source: "proxy" });
  emit("image.build_started");
  await expect(status).toHaveText("Building sandbox image");
  emit("workspace.scanning", { workspace: "project" });
  emit("workspace.copy_progress", { workspace: "project", copied: 3, total: 10 });
  await expect(status).toHaveText("Copying project · 3/10 files");
  emit("workspace.copy_progress", { workspace: "project", copied: 10, total: 10 });
  emit("workspace.copied", { count: 1, skipped: 2 });
  await expect(status).toHaveText("Workspace copies ready · 2 excluded entries");
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
  emit("workspace.changes_scanning");
  emit("workspace.changes_saving", { count: 1 });
  emit("workspace.changes_saved", { proposalId: "proposal" });
  emit("workspace.cleanup_started");
  emit("workspace.cleanup_completed");
  await expect(status).toHaveText("Workspace copies removed");
  await node.locator(".sandbox-activity summary").click();
  await expect(node.getByText("Workspace changes saved for review", { exact: true })).toBeVisible();
  await expect(node.getByText("Copying project · 10/10 files", { exact: true })).toBeAttached();
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

test("sandbox editor preserves drafts and recommendations without running or applying them", async ({ page }) => {
  const state = await setup(page);
  const recommendation = 'Consider more memory.\n```json\n{"sandbox":{"memory":"4g"}}\n```';
  let adviceRequests = 0;
  await page.route("**/api/sandbox/recommend", async (route) => {
    adviceRequests++;
    expect(route.request().postDataJSON().model).toBe("chat-latest");
    await route.fulfill({ json: { text: recommendation } });
  });
  const open = page.getByRole("button", { name: "Sandbox configuration", exact: true });
  await open.click();
  const panel = page.getByRole("complementary", { name: "Sandbox Configuration" });
  const editor = panel.getByRole("textbox", { name: "Configuration", exact: true });
  const defaults = await editor.inputValue();
  await editor.fill('{"sandbox":');
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await open.click();
  await expect(editor).toHaveValue('{"sandbox":');
  const saved = '{"sandbox":{"memory":"4g"}}';
  await editor.fill(saved);
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.graph.nodes[0].data.sandboxConfig).toBe(saved);
  expect(state.executions).toHaveLength(0);
  await panel.getByRole("textbox", { name: "Instructions" }).fill("Review the memory limit");
  await panel.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Recommendation" })).toContainText('Consider more memory.');
  await expect(panel.getByRole("region", { name: "Recommendation" }).locator("pre code")).toHaveText('{"sandbox":{"memory":"4g"}}\n');
  await expect(editor).toHaveValue(saved);
  expect(adviceRequests).toBe(1);
  expect(state.executions).toHaveLength(0);
  await panel.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(editor).toHaveValue(defaults);
  await expect.poll(() => state.graph.nodes[0].data.sandboxPanel.draft).toBe(defaults);
  expect(state.graph.nodes[0].data.sandboxConfig).toBe(saved);
  await page.reload();
  await open.click();
  await expect(editor).toHaveValue(defaults);
  await expect(panel.getByRole("region", { name: "Recommendation" })).toContainText('Consider more memory.');
  await expect(panel.getByRole("textbox", { name: "Instructions" })).toHaveValue("Review the memory limit");
  expect(state.executions).toHaveLength(0);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  state.complete = true;
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect.poll(() => state.executions.length).toBe(1);
  expect(state.executions[0].sandboxConfig).toBe(saved);
});

test("sandbox recommendations finish into their original node after switching panels", async ({ page }) => {
  const state = await setup(page);
  let finish: (() => void) | undefined;
  await page.route("**/api/sandbox/recommend", async (route) => {
    await new Promise<void>((resolve) => { finish = resolve; });
    await route.fulfill({ json: { text: "First node recommendation" } });
  });
  await page.getByRole("button", { name: "Sandbox configuration", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Sandbox Configuration" });
  await panel.getByRole("textbox", { name: "Configuration", exact: true }).fill('{"sandbox":{"cpus":3}}');
  await panel.getByRole("textbox", { name: "Instructions" }).fill("Review this");
  await panel.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => !!finish).toBe(true);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Add Step", exact: true }).click();
  await page.getByRole("button", { name: "Sandbox configuration", exact: true }).nth(1).click();
  finish!();
  await expect.poll(() => state.graph.nodes[0].data.sandboxPanel?.recommendation).toBe("First node recommendation");
  await expect(panel.getByRole("region", { name: "Recommendation" })).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "Instructions" })).toHaveValue("");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Sandbox configuration", exact: true }).first().click();
  await expect(panel.getByRole("region", { name: "Recommendation" })).toHaveText("First node recommendation");
  await expect(panel.getByRole("textbox", { name: "Configuration", exact: true })).toHaveValue('{"sandbox":{"cpus":3}}');
  expect(state.graph.nodes[0].data.sandboxConfig).toBeUndefined();
  expect(state.executions).toHaveLength(0);
});

test("all side panels resize and retain their individual widths", async ({ page }) => {
  await setup(page);
  for (const [button, label, resizeLabel, width] of [
    ["Settings", "Settings", "Resize settings panel", 510],
    ["Sandbox configuration", "Sandbox Configuration", "Resize sandbox configuration panel", 610],
    ["Trace Logs", "Trace Logs", "Resize trace panel", 560],
  ] as const) {
    await page.getByRole("button", { name: button, exact: true }).click();
    const panel = page.getByRole("complementary", { name: label, exact: true });
    const grip = panel.getByRole("separator", { name: resizeLabel });
    const box = (await grip.boundingBox())!;
    await page.mouse.move(box.x + box.width - 1, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(page.viewportSize()!.width - width, box.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect(panel).toHaveCSS("width", `${width}px`);
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(panel).toHaveCSS("width", `${width}px`);
    await panel.getByRole("button", { name: "Close", exact: true }).click();
  }
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Settings", exact: true })).toHaveCSS("width", "510px");
});

test("per-node tool switches persist and are sent with runs", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 2400 });
  const state = await setup(page);
  const graph = seed() as any;
  graph.nodes[0].data.workspaces = [{ id: "ws", path: "/tmp/project" }];
  graph.nodes[0].data.tools = [{ id: "custom", label: "Example", kind: "custom", fnName: "example", fnCode: "return 1" }];
  state.graph = graph;
  await page.evaluate((g) => {
    localStorage.setItem("mnemonic.graph.v1", JSON.stringify(g));
    localStorage.setItem("mnemonic.graph.sync.v1", JSON.stringify({ revision: 1, dirty: false }));
  }, graph);
  await page.reload();
  await expect(page.getByLabel("Enable workspace_write", { exact: true })).toBeChecked();
  await expect(page.locator(".tool").filter({ hasText: "workspace_write" }).getByRole("button", { name: "Remove tool" })).toBeDisabled();
  await page.getByLabel("Enable workspace_write", { exact: true }).locator("..").click();
  await page.getByLabel("Enable Example", { exact: true }).locator("..").click();
  await expect.poll(() => state.graph.nodes[0].data.workspaceTools?.workspace_write).toBe(false);
  await expect.poll(() => state.graph.nodes[0].data.tools[0].enabled).toBe(false);
  await page.reload();
  await expect(page.getByLabel("Enable workspace_write", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Enable Example", { exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect.poll(() => state.executions.length).toBe(1);
  expect(state.executions[0].workspaceTools.workspace_write).toBe(false);
  expect(state.executions[0].tools[0].enabled).toBe(false);
});

test("sandbox changes track partial acceptance and completion across refresh", async ({ page }) => {
  const state = await setup(page);
  state.complete = true;
  const proposal = { id: "saved-proposal", changes: ["first.txt", "second.txt"].map((path, index) => ({
    id: String(index), workspace: "project", path, kind: "modified", accepted: false,
    before: { text: "original content", bytes: 16, binary: false, truncated: false },
    after: { text: "proposed content", bytes: 16, binary: false, truncated: false } })) };
  let accepts = 0;
  await page.route("**/api/executions/**", (route) => route.fulfill({ json: { status: "ok", model: "test", text: "Proposed edits", workspaceChanges: proposal.id } }));
  await page.route("**/api/workspace-changes/**", (route) => {
    if (route.request().url().endsWith("/summary")) return route.fulfill({ json: { id: proposal.id, pending: proposal.changes.filter((c) => !c.accepted).length } });
    if (route.request().method() === "POST") {
      accepts++;
      const selected = route.request().postDataJSON().files;
      proposal.changes.forEach((change) => { if (selected.includes(change.id)) change.accepted = true; });
    }
    return route.fulfill({ json: proposal });
  });
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review changes (2)", exact: true })).toBeVisible();
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.reload();
  await page.getByRole("button", { name: "Review changes (2)", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Workspace changes" });
  await expect(page.getByRole("separator", { name: "Resize workspace changes panel" })).toBeVisible();
  await panel.getByRole("button", { name: "project/first.txt", exact: true }).click();
  await expect(panel.getByRole("button", { name: "project/first.txt", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByRole("checkbox").first()).toBeChecked();
  await expect(panel.getByText("original content", { exact: true }).first()).toBeVisible();
  expect(accepts).toBe(0);
  await panel.getByRole("checkbox").nth(1).uncheck();
  await panel.getByRole("button", { name: "Accept (1)", exact: true }).click();
  await expect(panel.getByRole("checkbox")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Review changes (1)", exact: true })).toBeVisible();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Accept (1)", exact: true }).click();
  await expect(panel.getByRole("button", { name: "All changes accepted.", exact: true })).toBeDisabled();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  await expect(page.locator(".react-flow__node-artifact").getByRole("button", { name: "All changes accepted.", exact: true })).toBeVisible();
  expect(accepts).toBe(2);
  expect(state.executions).toHaveLength(1);
  await page.reload();
  await page.locator(".react-flow__node-artifact").getByRole("button", { name: "All changes accepted.", exact: true }).click();
  await expect(panel.getByRole("button", { name: "All changes accepted.", exact: true })).toBeDisabled();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
});

test("external provider sandbox remains selectable after a failed availability check", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1800 });
  const state = await setup(page);
  let available = false;
  let checks = 0;
  await page.route("**/api/sandbox", (route) => {
    checks++;
    return route.fulfill({ json: { available, reason: available ? undefined : "Docker is starting." } });
  });
  await page.reload();
  await expect.poll(() => checks).toBeGreaterThan(0);
  const toggle = page.getByRole("checkbox", { name: "Run in a sandbox", exact: true });
  await expect(toggle).toBeEnabled();
  await page.locator(".sandbox-control").filter({ hasText: "Run in a sandbox" }).click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText("Docker is starting.", { exact: true })).toBeVisible();
  await expect.poll(() => state.graph.nodes[0].data.sandbox).toBe(true);
  const before = checks;
  available = true;
  await toggle.press("Space");
  await toggle.press("Space");
  await expect.poll(() => checks).toBeGreaterThan(before);
  await expect(page.getByText("Docker is starting.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect.poll(() => state.executions.length).toBe(1);
  expect(state.executions[0].sandbox).toBe(true);
});


test("provider settings expand independently and save to their own provider", async ({ page }) => {
  await setup(page);
  const saved: any[] = [];
  await page.route("**/api/settings*", async (route) => {
    const patch = route.request().method() === "POST" ? route.request().postDataJSON() : null;
    if (patch) saved.push(patch);
    const provider = patch?.provider ?? new URL(route.request().url()).searchParams.get("provider") ?? "openai";
    return route.fulfill({ json: { provider, keySource: "none", hasPanelKey: false, baseUrl: patch?.baseUrl ?? "", runLocally: false } });
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Settings", exact: true });
  await expect(panel.getByRole("combobox")).toHaveCount(0);
  const openai = panel.getByRole("region", { name: "OpenAI settings", exact: true });
  await openai.getByLabel("API key", { exact: true }).fill("openai-draft");
  await panel.locator("summary").filter({ hasText: "OpenAI-compatible" }).click();
  await panel.locator("summary").filter({ hasText: "Hugging Face" }).click();
  const compatible = panel.getByRole("region", { name: "OpenAI-compatible settings", exact: true });
  const huggingface = panel.getByRole("region", { name: "Hugging Face settings", exact: true });
  await expect(openai).toBeVisible();
  await expect(compatible).toBeVisible();
  await expect(huggingface).toBeVisible();
  await compatible.getByLabel("API key", { exact: true }).fill("compatible-key");
  await compatible.getByRole("button", { name: "Set Key", exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toEqual({ provider: "compatible", apiKey: "compatible-key" });
  await expect(openai.getByLabel("API key", { exact: true })).toHaveValue("openai-draft");
  await panel.locator("summary").filter({ hasText: /^OpenAI$/ }).click();
  await panel.locator("summary").filter({ hasText: /^OpenAI$/ }).click();
  await expect(openai.getByLabel("API key", { exact: true })).toHaveValue("openai-draft");
  await huggingface.getByLabel("Base URL", { exact: true }).fill("http://localhost:8000/v1");
  await huggingface.getByRole("button", { name: "Set Base URL", exact: true }).click();
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[1]).toEqual({ provider: "huggingface", baseUrl: "http://localhost:8000/v1" });
});
