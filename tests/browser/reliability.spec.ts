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

async function runStep(page: Page) {
  await page.getByRole("button", { name: "Run", exact: true }).click();
}

async function addContextFor(page: Page, targetId: string, input: string) {
  await page.getByRole("button", { name: "Context", exact: true }).click();
  const context = page.locator(".react-flow__node-context").last();
  await context.locator("textarea.prompt").fill(input);
  await page.locator(".react-flow__controls-fitview").click();
  await context.locator(".react-flow__handle.source").dragTo(
    page.locator(`.react-flow__node[data-id="${targetId}"] .react-flow__handle.target`),
  );
  return context;
}

test("left drag separates node movement from canvas panning and handles have forgiving connection targets", async ({ page }) => {
  const state = await setup(page);
  const node = page.locator('.react-flow__node-step[data-id="step"]');
  const before = { ...state.graph.nodes[0].position };
  const viewportBefore = await page.locator(".react-flow__viewport").getAttribute("style");
  const box = (await node.locator(".node").boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 85, box.y + 45, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => state.graph.nodes[0].position).not.toEqual(before);
  expect(await page.locator(".react-flow__viewport").getAttribute("style")).toBe(viewportBefore);

  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  await page.mouse.move(pane.x + pane.width - 80, pane.y + 80);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width - 140, pane.y + 120, { steps: 5 });
  await page.mouse.up();
  expect(await page.locator(".react-flow__viewport").getAttribute("style")).not.toBe(viewportBefore);

  await page.getByRole("button", { name: "Inference", exact: true }).click();
  const second = page.locator(".react-flow__node-step").last();
  const secondId = (await second.getAttribute("data-id"))!;
  const source = node.locator(".react-flow__handle.source");
  const target = second.locator(".react-flow__handle.target");
  expect((await source.boundingBox())!.width).toBeGreaterThanOrEqual(24);
  expect((await target.boundingBox())!.width).toBeGreaterThanOrEqual(24);
  await source.dragTo(target);
  await expect.poll(() => state.graph.edges.some((edge: any) => edge.source === "step" && edge.target === secondId)).toBe(true);
});

test("canvas can zoom out beyond the React Flow default", async ({ page }) => {
  await setup(page);
  const controls = page.locator(".react-flow__controls");
  await expect(controls.locator("button")).toHaveCount(3);
  await expect(controls.locator("button[title]")).toHaveCount(0);
  await expect(controls.locator(".react-flow__controls-interactive")).toHaveCount(0);
  const minimap = page.locator(".react-flow__minimap-svg");
  await expect(minimap.locator("title")).toHaveCount(0);
  await expect(minimap).toHaveAttribute("aria-label", "Mini Map");
  const zoomOut = page.locator(".react-flow__controls-zoomout");
  for (let index = 0; index < 30 && await zoomOut.isEnabled(); index++) await zoomOut.click();
  const transform = await page.locator(".react-flow__viewport").getAttribute("style");
  const scale = Number(transform?.match(/scale\(([^)]+)\)/)?.[1]);
  expect(scale).toBeLessThan(0.5);
  expect(scale).toBeGreaterThanOrEqual(0.1);
  expect(scale).toBeLessThanOrEqual(0.11);
});

test("header import uses a pointer cursor across the file input surface", async ({ page }) => {
  await setup(page);
  const input = page.getByLabel("Import", { exact: true });
  await expect(input.locator("..")).toHaveCSS("cursor", "pointer");
  await expect(input).toHaveCSS("cursor", "pointer");
});

test("input cards use the active-toggle blue palette", async ({ page }) => {
  await setup(page);
  const input = page.locator('.react-flow__node-step[data-id="step"]');
  await input.getByRole("checkbox", { name: "Loop node", exact: true }).press("Space");
  await expect(input.getByRole("checkbox", { name: "Loop node", exact: true })).toBeChecked();
  await page.waitForTimeout(180);
  const appearance = await input.evaluate((node) => {
    const card = node.querySelector(".node")!;
    const field = node.querySelector("select")!;
    const track = node.querySelector('.loop-controls .skip.sandbox .track')!;
    return {
      palette: getComputedStyle(card).getPropertyValue("--input-blue").trim(),
      card: getComputedStyle(card).backgroundColor,
      field: getComputedStyle(field).backgroundColor,
      toggleBorder: getComputedStyle(track).borderColor,
      toggleKnob: getComputedStyle(track, "::after").backgroundColor,
    };
  });
  expect(appearance).toEqual({
    palette: "#6ea8fe",
    card: "rgb(20, 32, 51)",
    field: "rgb(26, 42, 64)",
    toggleBorder: "rgb(110, 168, 254)",
    toggleKnob: "rgb(110, 168, 254)",
  });
  await input.getByRole("checkbox", { name: "Loop node", exact: true }).press("Space");
  const blueControls = await input.evaluate((node) => {
    const styleOf = (selector: string) => {
      const style = getComputedStyle(node.querySelector(selector)!);
      return { color: style.color, background: style.backgroundColor, border: style.borderColor };
    };
    const disabledStyle = (selector: string) => {
      const style = getComputedStyle(node.querySelector(selector)!);
      return {
        opacity: style.opacity,
        cursor: style.cursor,
        color: style.color,
        background: style.backgroundColor,
        border: style.borderColor,
      };
    };
    return {
      addTool: styleOf(".add-tool"),
      toolHeadingSize: getComputedStyle(node.querySelector(".tools-head")!).fontSize,
      nameSize: getComputedStyle(node.querySelector(".label")!).fontSize,
      sandboxGear: styleOf(".sandbox-config-open"),
      disabledLoopMode: disabledStyle(".loop-output-mode"),
      disabledLoopLimit: disabledStyle(".loop-limit .line"),
    };
  });
  expect(blueControls.addTool).toEqual({
    color: "rgb(110, 168, 254)", background: "rgb(26, 42, 64)", border: "rgb(54, 91, 133)",
  });
  expect(blueControls.toolHeadingSize).toBe(blueControls.nameSize);
  expect(blueControls.sandboxGear).toEqual({
    color: "rgb(110, 168, 254)", background: "rgb(26, 42, 64)", border: "rgba(0, 0, 0, 0)",
  });
  expect(blueControls.disabledLoopMode).toMatchObject({ opacity: "0.38", cursor: "not-allowed" });
  expect(blueControls.disabledLoopLimit).toEqual(blueControls.disabledLoopMode);

  const context = page.locator(".react-flow__node-context").first();
  const prompt = context.getByRole("textbox", { name: "Input Copy input", exact: true });
  const instructions = context.getByRole("textbox", { name: "Instructions (System Prompt + Role) Copy instructions", exact: true });
  const copyInput = context.getByRole("button", { name: "Copy input", exact: true });
  const copyInstructions = context.getByRole("button", { name: "Copy instructions", exact: true });
  await expect(copyInstructions).toBeDisabled();
  await instructions.locator("..").hover();
  await expect(copyInstructions).toHaveCSS("opacity", "0.35");
  await instructions.fill("Use concise answers.");
  await page.locator(".brand").hover();
  await expect(copyInput).toHaveCSS("opacity", "0");
  await expect(copyInstructions).toHaveCSS("opacity", "0");
  await expect(prompt).toHaveCSS("padding-right", "6px");
  await expect(instructions).toHaveCSS("padding-right", "6px");
  await prompt.locator("..").hover();
  await expect(copyInput).toHaveCSS("opacity", "1");
  await copyInput.hover();
  await expect(copyInput).toHaveCSS("border-color", "rgb(95, 208, 138)");
  await instructions.locator("..").hover();
  await expect(copyInstructions).toHaveCSS("opacity", "1");
  await copyInstructions.hover();
  await expect(copyInstructions).toHaveCSS("border-color", "rgb(95, 208, 138)");

  const collapse = input.getByRole("button", { name: "Collapse step", exact: true });
  await collapse.hover();
  await expect(collapse).toHaveCSS("color", "rgb(110, 168, 254)");
  await expect(collapse).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  const greenStyle = async (locator: ReturnType<Page["locator"]>) => locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor, border: style.borderColor };
  });
  const runStyle = await greenStyle(input.getByRole("button", { name: "Run", exact: true }));
  await input.getByRole("button", { name: "Sandbox configuration", exact: true }).click();
  const saveStyle = await greenStyle(page.getByRole("complementary", { name: "Sandbox Configuration" })
    .getByRole("button", { name: "Save", exact: true }));
  expect(runStyle).toEqual({
    color: saveStyle.color,
    background: "rgb(26, 42, 64)",
    border: saveStyle.border,
  });
});

test("node creation buttons match their node palettes", async ({ page }) => {
  await setup(page);
  await expect(page.locator(".brand")).toHaveText(/mnemonic\s*\|\s*Saved/);
  await expect(page.locator(".brand .tagline, .save-status-dot")).toHaveCount(0);
  const primaryActions = page.locator(".bar-right > button");
  await expect(primaryActions.nth(0)).toHaveText("Context");
  await expect(primaryActions.nth(1)).toHaveText("Inference");
  await expect(primaryActions.nth(2)).toHaveText("Comment");
  await expect(primaryActions.nth(3)).toHaveText("Clear canvas");
  const styles = async (name: "Inference" | "Context" | "Comment") => page.getByRole("button", { name, exact: true }).evaluate((button) => {
    const style = getComputedStyle(button);
    return { color: style.color, background: style.backgroundColor, border: style.borderColor };
  });
  expect(await styles("Inference")).toEqual({
    color: "rgb(110, 168, 254)",
    background: "rgb(26, 42, 64)",
    border: "rgb(54, 91, 133)",
  });
  expect(await styles("Context")).toEqual({
    color: "rgb(95, 208, 138)",
    background: "rgb(24, 52, 38)",
    border: "rgb(57, 122, 85)",
  });
  expect(await styles("Comment")).toEqual({
    color: "rgb(255, 209, 0)",
    background: "rgb(51, 47, 18)",
    border: "rgb(143, 121, 16)",
  });
  await page.getByRole("button", { name: "Inference", exact: true }).click();
  const added = page.locator(".react-flow__node-step").last();
  await expect(added.locator(".node")).toHaveClass(/collapsed/);
  await expect(added.getByRole("button", { name: "Expand step", exact: true })).toBeVisible();
  await expect(added.getByRole("textbox", { name: "Step name", exact: true })).toHaveValue("Unnamed");
});

test("the idle Stop all slot confirms before clearing every node and edge", async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByRole("button", { name: "Clear canvas", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop all", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const comment = page.locator(".react-flow__node-comment");
  await page.locator(".react-flow__controls-fitview").click();
  await comment.locator(".react-flow__handle.source").dragTo(
    page.locator('.react-flow__node-step[data-id="step"] .react-flow__handle.target'),
  );
  const commentId = (await comment.getAttribute("data-id"))!;
  await expect.poll(() => state.graph.edges.some((edge: any) => edge.source === commentId && edge.target === "step")).toBe(true);

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toBe("Are you sure you want to clear the entire canvas?");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Clear canvas", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Are you sure you want to clear the entire canvas?");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Clear canvas", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect.poll(() => ({ nodes: state.graph.nodes.length, edges: state.graph.edges.length }))
    .toEqual({ nodes: 0, edges: 0 });
  await expect(page.getByRole("button", { name: "Clear canvas", exact: true })).toBeVisible();
});

test("comments provide named Markdown context and are traced with the next step", async ({ page }) => {
  const state = await setup(page);
  state.complete = true;
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const comment = page.locator(".react-flow__node-comment");
  await expect(comment).toHaveCount(1);
  await comment.getByRole("textbox", { name: "Comment author", exact: true }).fill("Ada");
  await comment.getByRole("textbox", { name: "Comment text", exact: true }).fill("Check the **assumptions**.");
  await comment.getByRole("button", { name: "Reply", exact: true }).click();
  await comment.getByRole("textbox", { name: "Reply 1 author", exact: true }).fill("Grace");
  await comment.getByRole("textbox", { name: "Reply 1 text", exact: true }).fill("I checked the **edge cases**.");
  const commentId = (await comment.getAttribute("data-id"))!;
  await expect.poll(() => state.graph.nodes.find((node: any) => node.id === commentId)?.data.replies?.length).toBe(1);
  const commentData = state.graph.nodes.find((node: any) => node.id === commentId).data;
  await expect(comment.locator("time")).toHaveCount(2);
  await expect(comment.locator(".comment-author").first()).toHaveCSS("gap", "2px");
  const authorBox = (await comment.getByRole("textbox", { name: "Comment author", exact: true }).boundingBox())!;
  const deleteBox = (await comment.getByRole("button", { name: "Delete comment", exact: true }).boundingBox())!;
  expect(Math.abs(authorBox.y - deleteBox.y)).toBeLessThanOrEqual(1);
  await expect(comment.locator("time").nth(0)).toHaveAttribute("datetime", new Date(commentData.createdAt).toISOString());
  await expect(comment.locator("time").nth(1)).toHaveAttribute("datetime", new Date(commentData.replies[0].createdAt).toISOString());
  await expect(comment.getByRole("button", { name: "Delete reply 1", exact: true })).toBeVisible();
  await comment.getByRole("button", { name: "Collapse comment", exact: true }).click();
  await expect(comment.getByRole("textbox", { name: "Comment text", exact: true })).toHaveCount(0);
  await expect(comment.getByRole("textbox", { name: "Comment author", exact: true })).toBeVisible();
  await expect(comment.getByRole("textbox", { name: "Reply 1 text", exact: true })).toBeVisible();
  await expect.poll(() => state.graph.nodes.find((node: any) => node.id === commentId)?.data.collapsed).toBe(true);
  await comment.getByRole("button", { name: "Expand comment", exact: true }).click();
  await comment.getByRole("button", { name: "Collapse reply 1", exact: true }).click();
  await expect(comment.getByRole("textbox", { name: "Reply 1 text", exact: true })).toHaveCount(0);
  await expect(comment.getByRole("textbox", { name: "Reply 1 author", exact: true })).toBeVisible();
  await expect(comment.getByRole("button", { name: "Delete reply 1", exact: true })).toBeVisible();
  await expect.poll(() => state.graph.nodes.find((node: any) => node.id === commentId)?.data.replies[0].collapsed).toBe(true);
  await comment.getByRole("button", { name: "Expand reply 1", exact: true }).click();
  const replyCopy = comment.getByRole("button", { name: "Copy reply 1", exact: true });
  await page.locator(".brand").hover();
  await expect(replyCopy).toHaveCSS("opacity", "0");
  await expect(comment.getByRole("button", { name: "Delete comment", exact: true })).toBeVisible();
  await expect(comment.getByRole("checkbox")).toHaveCount(0);
  await expect(comment.locator(".react-flow__handle.target")).toHaveCount(0);
  const commentCopy = comment.getByRole("button", { name: "Copy comment", exact: true });
  await expect(commentCopy).not.toHaveAttribute("title");
  await page.locator(".brand").hover();
  await expect(commentCopy).toHaveCSS("opacity", "0");
  await expect(comment.getByRole("button", { name: /(?:Edit|Preview) (?:comment|reply)/ })).toHaveCount(0);
  await expect(comment.getByRole("textbox", { name: "Comment text", exact: true })).toHaveCSS("padding-right", "6px");
  await commentCopy.hover({ force: true });
  await expect(commentCopy).toHaveCSS("border-color", "rgb(255, 209, 0)");
  const appearance = await comment.locator(".node").evaluate((node) => ({
    width: (node as HTMLElement).offsetWidth,
    yellow: getComputedStyle(node).getPropertyValue("--sticky-yellow").trim(),
    textHeight: (node.querySelector(".text") as HTMLElement).offsetHeight,
  }));
  expect(appearance).toEqual({ width: 240, yellow: "#ffd100", textHeight: 105 });

  await page.locator(".react-flow__controls-fitview").click();
  const source = comment.locator(".react-flow__handle.source");
  const target = page.locator('.react-flow__node-step[data-id="step"] .react-flow__handle.target');
  await source.dragTo(target);
  await expect.poll(() => state.graph.edges.some((edge: any) => edge.source === commentId && edge.target === "step")).toBe(true);
  await runStep(page);
  await expect.poll(() => state.executions.length).toBe(1);
  expect(state.executions[0].trace.context).toEqual([
    { label: "Ada", text: "Check the **assumptions**." },
    { label: "Grace", text: "I checked the **edge cases**." },
    { label: "Step 1", text: "Make an output" },
  ]);
  expect(state.executions[0].input).toContain('<context from="Ada">\nCheck the **assumptions**.\n</context>');
  expect(state.executions[0].input).toContain('<context from="Grace">\nI checked the **edge cases**.\n</context>');

  await expect(comment.getByRole("textbox", { name: "Comment text", exact: true })).toHaveValue("Check the **assumptions**.");
  await expect(comment.getByRole("textbox", { name: "Reply 1 text", exact: true })).toHaveValue("I checked the **edge cases**.");
});

test("outputs call an unnamed source step Unnamed", async ({ page }) => {
  const state = await setup(page);
  state.complete = true;
  await page.getByRole("textbox", { name: "Step name", exact: true }).fill("Name this step");
  await runStep(page);
  const output = page.locator(".react-flow__node-artifact");
  await expect(output).toHaveCount(1);
  await expect(output.locator(".meta .dim")).toContainText("Unnamed ·");
  await expect(output.locator(".meta .dim")).not.toContainText("Name this step");
  await expect(output.locator(".meta .dim")).not.toContainText("off");
  await expect(output.locator("footer.tokens")).toHaveText("off");
  await expect.poll(() => state.graph.nodes.find((node: any) => node.type === "artifact")?.data.createdAt).toBeTruthy();
  const createdAt = state.graph.nodes.find((node: any) => node.type === "artifact").data.createdAt;
  await expect(output.locator("time")).toHaveAttribute("datetime", new Date(createdAt).toISOString());
});

test("fan-out outputs and their successive sets render as staggered clusters", async ({ page }) => {
  const state = await setup(page, 3);
  state.complete = true;
  await runStep(page);
  const outputs = page.locator(".react-flow__node-artifact");
  await expect(outputs).toHaveCount(3);

  const inputBox = (await page.locator('.react-flow__node-step[data-id="step"]').boundingBox())!;
  const outputBoxes = await outputs.evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }).sort((a, b) => a.y - b.y));
  expect(outputBoxes[0].x - (inputBox.x + inputBox.width)).toBeGreaterThan(50);
  const byX = [...outputBoxes].sort((a, b) => a.x - b.x);
  expect(byX[1].y).toBeGreaterThan(byX[0].y);
  expect(byX[2].y).toBeLessThan(byX[1].y);
  expect(byX[1].x - byX[0].x).toBeLessThan(byX[0].width);
  expect(byX[2].x - byX[1].x).toBeLessThan(byX[1].width);

  await runStep(page);
  await expect(outputs).toHaveCount(6);
  await runStep(page);
  await expect(outputs).toHaveCount(9);
  await expect.poll(() => state.graph.nodes.filter((node: any) => node.type === "artifact").length).toBe(9);
  const anchors = [0, 1, 2].map((setIndex) => state.graph.nodes.find((node: any) =>
    node.type === "artifact" && node.data.outputSetIndex === setIndex));
  expect(anchors.every(Boolean)).toBe(true);
  expect(anchors[1].position.x).toBeGreaterThan(anchors[0].position.x);
  expect(anchors[1].position.y).toBeGreaterThan(anchors[0].position.y);
  expect(anchors[1].position.y - anchors[0].position.y).toBeGreaterThan(300);
  expect(anchors[2].position.x).toBe(anchors[1].position.x);
  expect(anchors[2].position.y).toBeLessThan(anchors[1].position.y);
  expect(anchors[2].position.y).toBeLessThan(anchors[0].position.y);
  const setBounds = [0, 1, 2].map((setIndex) => {
    const members = state.graph.nodes.filter((node: any) => node.type === "artifact" && node.data.outputSetIndex === setIndex);
    return { left: Math.min(...members.map((node: any) => node.position.x)),
      right: Math.max(...members.map((node: any) => node.position.x + 300)),
      top: Math.min(...members.map((node: any) => node.position.y)),
      bottom: Math.max(...members.map((node: any) => node.position.y + 336)) };
  });
  const overlaps = (a: typeof setBounds[number], b: typeof setBounds[number]) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  expect(overlaps(setBounds[0], setBounds[1])).toBe(false);
  expect(overlaps(setBounds[0], setBounds[2])).toBe(false);
  expect(overlaps(setBounds[1], setBounds[2])).toBe(false);
});

test("input nodes collapse to their name and primary actions and persist", async ({ page }) => {
  const state = await setup(page);
  const node = page.locator('.react-flow__node-step[data-id="step"]');

  await node.getByRole("button", { name: "Collapse step", exact: true }).click();
  await expect(node.getByRole("button", { name: "Expand step", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(node.getByRole("textbox", { name: "Step name", exact: true })).toBeVisible();
  await expect(node.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await expect(node.getByRole("checkbox", { name: "Node active — turn off to skip" })).toHaveCount(0);
  await expect(node.getByRole("button", { name: "Delete step", exact: true })).not.toHaveAttribute("title");
  await expect(node.getByRole("button", { name: "Delete step", exact: true })).toBeVisible();
  await expect(node.getByRole("combobox", { name: "Provider", exact: true })).toBeVisible();
  await expect(node.getByRole("combobox", { name: "Model", exact: true })).toBeVisible();
  await expect(node.getByRole("combobox", { name: "Thinking", exact: true })).toHaveCount(0);
  await expect(node.locator("textarea")).toHaveCount(0);
  await expect.poll(() => state.graph.nodes[0].data.collapsed).toBe(true);

  await page.reload();
  await expect(node.getByRole("button", { name: "Expand step", exact: true })).toBeVisible();
  await node.getByRole("button", { name: "Expand step", exact: true }).click();
  await expect(node.getByRole("combobox", { name: "Thinking", exact: true })).toBeVisible();
});

test("edges use orthogonal routes and backward edges clear node bodies", async ({ page }) => {
  const state = await setup(page);
  const graph = seed() as any;
  graph.nodes[0].id = "left";
  graph.nodes[0].position = { x: 0, y: 300 };
  graph.nodes.push({ ...structuredClone(graph.nodes[0]), id: "right", position: { x: 700, y: 500 } });
  graph.edges = [
    { id: "forward", source: "left", target: "right" },
    { id: "backward", source: "right", target: "left" },
  ];
  state.graph = graph;
  await page.evaluate((saved) => {
    localStorage.setItem("mnemonic.graph.v1", JSON.stringify(saved));
    localStorage.setItem("mnemonic.graph.sync.v1", JSON.stringify({ revision: 1, dirty: false }));
  }, graph);
  await page.reload();

  const forward = page.getByTestId("rf__edge-forward").locator(".react-flow__edge-path");
  const backward = page.getByTestId("rf__edge-backward").locator(".react-flow__edge-path");
  await expect(forward).toHaveCount(1);
  await expect(backward).toHaveCount(1);
  await expect.poll(async () => (await forward.getAttribute("d"))?.includes("L")).toBe(true);
  expect(await forward.getAttribute("d")).not.toContain("C");
  await expect.poll(async () => (await backward.getAttribute("d"))?.includes("Q")).toBe(true);

  const nodeHeight = await page.locator('.react-flow__node-step[data-id="right"]').evaluate((node) => (node as HTMLElement).offsetHeight);
  const bounds = await backward.evaluate((path) => {
    const box = (path as SVGGraphicsElement).getBBox();
    return { y: box.y, height: box.height };
  });
  expect(bounds.y + bounds.height).toBeGreaterThan(500 + nodeHeight + 40);

  const originalPath = await forward.getAttribute("d");
  await page.getByTestId("rf__edge-forward").locator(".react-flow__edge-interaction").click({ force: true });
  const controls = page.getByTestId("rf__edge-forward").locator(".edge-control-hit");
  await expect(controls).toHaveCount(1);
  await expect(controls.first()).toHaveClass(/axis-x/);
  const control = controls.first();
  const controlBox = (await control.boundingBox())!;
  await page.mouse.move(controlBox.x + controlBox.width / 2, controlBox.y + controlBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(controlBox.x + controlBox.width / 2 + 80, controlBox.y + controlBox.height / 2 - 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => state.graph.edges.find((edge: any) => edge.id === "forward")?.data?.route).toBeTruthy();
  await expect.poll(() => forward.getAttribute("d")).not.toBe(originalPath);
  await expect.poll(async () => (await forward.getAttribute("d"))?.includes("L")).toBe(true);

  await page.getByTestId("rf__edge-forward").locator(".edge-control-hit").first().dblclick({ force: true });
  await expect.poll(() => state.graph.edges.find((edge: any) => edge.id === "forward")?.data?.route ?? null).toBeNull();
  await expect.poll(() => forward.getAttribute("d")).toBe(originalPath);

  await page.getByTestId("rf__edge-backward").locator(".react-flow__edge-interaction").click({ force: true });
  const backwardControls = page.getByTestId("rf__edge-backward").locator(".edge-control-hit");
  await expect(backwardControls).toHaveCount(3);
  await expect(page.getByTestId("rf__edge-backward").locator(".edge-control-hit.axis-y")).toHaveCount(1);
});

test("refresh recovers pending output exactly once", async ({ page }) => {
  const state = await setup(page);
  await runStep(page);
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
  await runStep(page);
  await expect.poll(() => state.executions.length).toBe(1);
  await page.getByRole("button", { name: "Stop all", exact: true }).click();
  await expect.poll(() => state.cancelled.size).toBe(1);
  state.complete = true;
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear canvas", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run all", exact: true })).toHaveCount(0);
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(0);
});

test("a completed output survives refresh before graph autosave succeeds", async ({ page }) => {
  const state = await setup(page);
  state.complete = true; state.offline = true;
  await runStep(page);
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(1);
  state.offline = false;
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
  expect(state.graph.nodes.filter((n: any) => n.type === "artifact")).toHaveLength(1);
});

test("partial fan-out keeps the successful output", async ({ page }) => {
  const state = await setup(page, 2); state.complete = true; state.partial = true;
  await runStep(page);
  const output = page.locator(".react-flow__node-artifact");
  await expect(output).toHaveCount(1);
  await expect(page.getByText(/1 of 2 generations failed/)).toBeVisible();
  await output.getByRole("button", { name: "Collapse output", exact: true }).click();
  await expect(output.locator(".field").first()).toHaveCount(0);
  await expect(output.locator("footer.tokens")).toBeVisible();
  await expect(output.getByRole("button", { name: "Delete output", exact: true })).toBeVisible();
  await expect.poll(() => state.graph.nodes.find((node: any) => node.type === "artifact")?.data.collapsed).toBe(true);
  await output.getByRole("button", { name: "Expand output", exact: true }).click();
  await expect(output.locator(".field").first()).toBeVisible();
  await expect(output.getByRole("checkbox", { name: "Node active — turn off to skip" })).toHaveCount(0);
  await expect(output.getByRole("button", { name: "Delete output", exact: true })).not.toHaveAttribute("title");
  const outputCopy = output.getByRole("button", { name: "Copy output", exact: true });
  const outputEdit = output.getByRole("button", { name: "Edit this output", exact: true });
  await expect(outputCopy).not.toHaveAttribute("title");
  await expect(outputEdit).not.toHaveAttribute("title");
  await page.locator(".brand").hover();
  await expect(outputCopy).toHaveCSS("opacity", "0");
  await expect(outputEdit).toHaveCSS("opacity", "0");
  await expect(output.locator(".text")).toHaveCSS("padding-right", "6px");
  await output.locator(".field").first().hover();
  await expect(outputCopy).toHaveCSS("opacity", "1");
  await expect(outputEdit).toHaveCSS("opacity", "1");
  await outputEdit.hover();
  await expect(outputEdit).toHaveCSS("border-color", "rgb(155, 108, 255)");
  await outputCopy.hover();
  await expect(outputCopy).toHaveCSS("border-color", "rgb(155, 108, 255)");
  await expect(outputCopy).toHaveCSS("color", "rgb(155, 108, 255)");
  const purple = await output.evaluate((node) =>
    getComputedStyle(node.querySelector(".node")!).getPropertyValue("--output-purple").trim());
  expect(purple).toBe("#9b6cff");
  await outputEdit.click();
  const finishEdit = output.getByRole("button", { name: "Done editing", exact: true });
  await expect(finishEdit).toBeVisible();
  await page.locator(".brand").hover();
  await expect(finishEdit).toHaveCSS("opacity", "0");
  await output.locator(".field").first().hover();
  await expect(finishEdit).toHaveCSS("opacity", "1");
  await output.getByRole("textbox", { name: "Output text", exact: true }).fill("");
  await expect(output.locator(".edited-flag")).toHaveText("Edited");
  await expect(output.locator(".output-stats")).toHaveText("off");
  const editedBox = (await output.locator(".edited-flag").boundingBox())!;
  const statsBox = (await output.locator(".output-stats").boundingBox())!;
  expect(editedBox.x).toBeGreaterThan(statsBox.x);
  await expect(outputCopy).toBeDisabled();
  await output.locator(".field").first().hover();
  await expect(outputCopy).toHaveCSS("opacity", "0.35");
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
  const state = await setup(page);
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
  const requiredSandbox = page.locator(".sandbox-main-control").first();
  await expect(requiredSandbox).toContainText("Run in a sandbox (Required)");
  await expect(requiredSandbox).not.toHaveAttribute("title");
  await page.getByRole("button", { name: "Inference", exact: true }).click();
  await page.getByRole("button", { name: "Expand step", exact: true }).last().click();
  await expect(switches).toHaveCount(2);
  await expect(switches.nth(1)).toBeChecked();
  await expect(switches.nth(1)).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Use GPU", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Sandbox configuration", exact: true }).first().click();
  const panel = page.getByRole("complementary", { name: "Sandbox Configuration" });
  const gpu = panel.getByRole("checkbox", { name: "Use GPU", exact: true });
  await expect(gpu).not.toBeChecked();
  await gpu.press("Space");
  await expect(gpu).toBeChecked();
  await expect.poll(() => state.graph.nodes[0].data.useGpu).toBe(true);
  await expect(panel.locator(".trace-list > label").first()).toContainText("Use GPU");
  await expect(panel.locator(".trace-list > label").nth(1)).toContainText("Configuration");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".sandbox-controls").first().getByRole("checkbox")).toHaveCount(1);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".provider-settings > summary").filter({ hasText: "Hugging Face" }).click();
  await page.getByRole("checkbox", { name: "Download and run models locally" }).press("Space");

  await expect(page.getByRole("region", { name: "Downloaded models" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Hugging Face settings" }).getByRole("textbox", { name: /Base URL/ })).toBeVisible();
  await expect(switches.first()).toBeEnabled();
  await expect(switches.first()).not.toBeChecked();
  await expect(page.locator(".sandbox-main-control").first()).toContainText("Run in a sandbox");
  await expect(page.locator(".sandbox-main-control").first()).not.toContainText("(Required)");
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
  await runStep(page);
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
  await page.getByRole("button", { name: "Inference", exact: true }).click();
  const second = page.locator(".react-flow__node-step").nth(1);
  await second.getByRole("button", { name: "Expand step", exact: true }).click();
  await expect(second.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue("openai");
  const secondId = (await second.getAttribute("data-id"))!;
  await addContextFor(page, secondId, "Another provider");
  state.complete = true;
  await node.getByRole("button", { name: "Run", exact: true }).click();
  await second.getByRole("button", { name: "Run", exact: true }).click();
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
  await node.getByRole("button", { name: "Run" }).click();
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
  await node.getByRole("button", { name: "Run" }).click();
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
  await panel.getByRole("button", { name: "Generate an AI recommendation", exact: true }).click();
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
  await runStep(page);
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
  await panel.getByRole("button", { name: "Generate an AI recommendation", exact: true }).click();
  await expect.poll(() => !!finish).toBe(true);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Inference", exact: true }).click();
  await page.getByRole("button", { name: "Expand step", exact: true }).last().click();
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
  const exampleTool = page.locator('.tool:has([aria-label="Enable Example"])');
  const removeTool = exampleTool.getByRole("button", { name: "Remove tool" });
  await expect(removeTool).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
  await expect(removeTool).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await removeTool.hover();
  await expect(removeTool).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
  await expect(removeTool).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.getByLabel("Enable workspace_write", { exact: true }).locator("..").click();
  await page.getByLabel("Enable Example", { exact: true }).locator("..").click();
  await expect.poll(() => state.graph.nodes[0].data.workspaceTools?.workspace_write).toBe(false);
  await expect.poll(() => state.graph.nodes[0].data.tools[0].enabled).toBe(false);
  await expect(exampleTool).toHaveClass(/disabled/);
  await expect(page.getByLabel("Enable Example", { exact: true })).toBeEnabled();
  await expect(removeTool).toBeEnabled();
  const toolName = exampleTool.getByRole("textbox", { name: "Tool name", exact: true });
  await expect(toolName).toBeDisabled();
  await expect(toolName).toHaveCSS("cursor", "not-allowed");
  await exampleTool.getByRole("button", { name: "Expand tool", exact: true }).click();
  const toolType = exampleTool.getByRole("combobox", { name: "Type", exact: true });
  const functionName = exampleTool.getByRole("textbox", { name: "Function name", exact: true });
  await expect(toolType).toBeDisabled();
  await expect(toolType).toHaveCSS("cursor", "not-allowed");
  await expect(functionName).toBeDisabled();
  await expect(functionName).toHaveCSS("cursor", "not-allowed");
  await expect(exampleTool.getByRole("button", { name: "Copy code", exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.locator(".tool").filter({ hasText: "workspace_write" })).toHaveClass(/disabled/);
  await expect(page.getByLabel("Enable workspace_write", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Enable Example", { exact: true })).not.toBeChecked();
  await runStep(page);
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
  await runStep(page);
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
  await runStep(page);
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
  await expect(panel.locator(".provider-settings[open]")).toHaveCount(0);
  await panel.locator("summary").filter({ hasText: /^OpenAI$/ }).click();
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

test("loop limit stops after the configured iterations and switches looping off", async ({ page }) => {
  const state = await setup(page);
  state.complete = true;
  const loop = page.locator('.react-flow__node-step[data-id="step"]');
  const toggle = loop.getByRole("checkbox", { name: "Loop node", exact: true });
  const limit = loop.getByRole("spinbutton", { name: "Loop iterations", exact: true });
  const outputMode = loop.getByRole("combobox", { name: "Loop outputs", exact: true });

  await expect(limit).toHaveValue("3");
  await expect(limit).toBeDisabled();
  await expect(outputMode).toHaveValue("last");
  await expect(outputMode).toBeDisabled();
  const loopBounds = await outputMode.locator("..").boundingBox();
  const modeBounds = await outputMode.boundingBox();
  const toolsBounds = await loop.locator(".tools").boundingBox();
  expect(loopBounds!.height).toBeGreaterThan(28);
  expect(modeBounds!.y + modeBounds!.height).toBeLessThanOrEqual(toolsBounds!.y);
  await toggle.press("Space");
  await expect(limit).toBeEnabled();
  await expect(outputMode).toBeEnabled();
  await limit.fill("2");
  await loop.getByRole("button", { name: "Start loop", exact: true }).click();
  await expect.poll(() => state.executions.length).toBe(2);
  await expect(toggle).not.toBeChecked();
  await expect(limit).toBeDisabled();
  await expect(outputMode).toBeDisabled();
  await expect(loop.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(2);
  await page.waitForTimeout(400);
  expect(state.executions).toHaveLength(2);
});

test("all-output loops preserve outputs, context, and trace routing while another node transforms feedback", async ({ page }) => {
  await page.setViewportSize({ width: 2000, height: 1600 });
  const state = await setup(page);
  const graph = seed() as any;
  graph.nodes[0].data.loop = true;
  state.graph = graph;
  await page.evaluate((g) => {
    localStorage.setItem("mnemonic.graph.v1", JSON.stringify(g));
    localStorage.setItem("mnemonic.graph.sync.v1", JSON.stringify({ revision: 1, dirty: false }));
  }, graph);
  const completed = new Map<string, string>();
  await page.route("**/api/executions/**", (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    if (parts.at(-1) === "cancel") {
      state.cancelled.add(parts.at(-2)!);
      return route.fulfill({ json: { cancelling: true } });
    }
    const id = parts.at(-1)!;
    return route.fulfill({ json: state.cancelled.has(id) ? { status: "error", error: "cancelled" }
      : completed.has(id) ? { status: "ok", text: completed.get(id), model: "test" } : { status: "pending" } });
  });
  await page.reload();
  const loop = page.locator('.react-flow__node-step[data-id="step"]');
  const outputMode = loop.getByRole("combobox", { name: "Loop outputs", exact: true });
  await expect(outputMode).toHaveValue("last");
  await outputMode.selectOption("all");
  await loop.getByRole("button", { name: "Start loop", exact: true }).click();
  await expect.poll(() => state.executions.length).toBe(1);
  await expect(page.getByRole("button", { name: "Run all", exact: true })).toHaveCount(0);
  completed.set(state.executions[0].trace.execId, "first loop output");
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(1);
  await expect.poll(() => state.executions.length).toBe(2);
  await page.getByRole("button", { name: "Inference", exact: true }).click();
  const transform = page.locator(".react-flow__node-step").last();
  await transform.getByRole("button", { name: "Expand step", exact: true }).click();
  await transform.getByRole("textbox", { name: "Step name", exact: true }).fill("Transform");
  const transformId = (await transform.getAttribute("data-id"))!;
  await addContextFor(page, transformId, "transform this");

  async function connect(sourceId: string, targetId: string) {
    await page.locator(".react-flow__controls-fitview").click();
    const source = page.locator(`.react-flow__node[data-id="${sourceId}"] .react-flow__handle.source`);
    const target = page.locator(`.react-flow__node[data-id="${targetId}"] .react-flow__handle.target`);
    await source.dragTo(target);
    await expect.poll(() => state.graph.edges.some((e: any) => e.source === sourceId && e.target === targetId)).toBe(true);
  }
  const firstId = (await page.locator(".react-flow__node-artifact").first().getAttribute("data-id"))!;
  await connect(firstId, transformId);
  await transform.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => state.executions.length).toBe(3);
  expect(state.executions[2].input).toContain("first loop output");
  completed.set(state.executions[2].trace.execId, "transformed feedback");
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(2);
  const feedback = page.locator(".react-flow__node-artifact").filter({ hasText: "transformed feedback" });
  const feedbackId = (await feedback.getAttribute("data-id"))!;
  await connect(feedbackId, "step");
  completed.set(state.executions[1].trace.execId, "second loop output");
  await expect.poll(() => state.executions.length).toBe(4);
  expect(state.executions[3].input).toContain("transformed feedback");
  expect(state.executions[1].trace.loopOutputMode).toBe("all");
  expect(state.executions[3].trace.context).toEqual([
    { label: "Transform", text: "transformed feedback" },
    { label: "Step 1", text: "Make an output" },
  ]);
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(3);
  const secondLoopId = (await page.locator(".react-flow__node-artifact").filter({ hasText: "second loop output" }).getAttribute("data-id"))!;
  await expect.poll(() => state.graph.edges.filter((edge: any) => edge.target === transformId
    && state.graph.nodes.some((node: any) => node.id === edge.source && node.type === "artifact")).map((edge: any) => edge.source)).toEqual([firstId, secondLoopId]);
  await loop.getByRole("button", { name: "Stop loop", exact: true }).click();
  await expect(loop.getByRole("button", { name: "Start loop", exact: true })).toBeVisible();
  expect(state.cancelled.has(state.executions[3].trace.execId)).toBe(true);
  expect(state.executions.filter((e) => e.trace.nodeId === "step").map((e) => e.trace.seq)).toEqual([0, 1, 2]);
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.reload();
  await expect(page.locator(".react-flow__node-artifact")).toHaveCount(3);
  await expect(loop.getByRole("button", { name: "Start loop", exact: true })).toBeVisible();
  expect(state.executions).toHaveLength(4);
});


test("context nodes own prompt resources and feed connected inferences", async ({ page }) => {
  const state = await setup(page);
  const graph = seed() as any;
  graph.nodes[0].id = "inference";
  graph.nodes[0].position = { x: 600, y: 0 };
  delete graph.nodes[0].data.prompt;
  graph.nodes.unshift({
    id: "sources", type: "context", position: { x: 0, y: 0 }, data: {
      label: "Sources", role: "researcher", instructions: "Use the supplied sources.", prompt: "Research brief",
      attachments: [{ id: "guide", name: "guide.md", text: "Standing guidance" }],
      files: [{ id: "file", name: "source.txt", mime: "text/plain", dataUrl: "data:text/plain;base64,U291cmNl" }],
      links: [{ id: "link", url: "https://example.com/source" }],
      workspaces: [{ id: "workspace", path: "/tmp/project" }],
    },
  });
  graph.edges = [{ id: "context-edge", source: "sources", target: "inference" }];
  state.graph = graph;
  await page.evaluate((saved) => {
    localStorage.setItem("mnemonic.graph.v1", JSON.stringify(saved));
    localStorage.setItem("mnemonic.graph.sync.v1", JSON.stringify({ revision: 1, dirty: false }));
  }, graph);
  await page.reload();

  const source = page.locator('.react-flow__node-context:has(input[aria-label="Context name"][value="Sources"])');
  await expect(source.getByRole("combobox", { name: "Provider", exact: true })).toHaveCount(0);
  await expect(source.getByText("Role", { exact: true })).toBeVisible();
  await expect(source.getByText(/Tools \(/)).toHaveCount(0);
  await expect(source.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
  await expect(source.locator("textarea.prompt")).toHaveValue("Research brief");
  await expect(source.getByRole("button", { name: "Add workspace", exact: true })).toBeVisible();
  await expect(source.getByRole("button", { name: "Add links", exact: true })).toBeVisible();

  await source.getByRole("button", { name: "Collapse context", exact: true }).click();
  await expect(source.locator("textarea.prompt")).toHaveValue("Research brief");
  await expect(source.getByText("Role", { exact: true })).toHaveCount(0);
  await expect(source.getByRole("button", { name: "Add workspace", exact: true })).toHaveCount(0);
  await expect(source.getByRole("button", { name: "Add links", exact: true })).toHaveCount(0);

  state.complete = true;
  await runStep(page);
  await expect.poll(() => state.executions.length).toBe(1);
  expect(state.executions[0].input).toBe('<context from="Sources">\nResearch brief\n</context>');
  expect(state.executions[0].instructions).toContain("Your role is: researcher\n\nUse the supplied sources.");
  expect(state.executions[0].instructions).toContain('<document name="guide.md">\nStanding guidance\n</document>');
  expect(state.executions[0].files).toEqual([{ name: "source.txt", mime: "text/plain", dataUrl: "data:text/plain;base64,U291cmNl" }]);
  expect(state.executions[0].links).toEqual(["https://example.com/source"]);
  expect(state.executions[0].workspaces).toEqual(["/tmp/project"]);
});
