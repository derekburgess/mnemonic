import type {
  Attachment,
  GraphEdge,
  GraphNode,
  InputFile,
  InputNode,
  OutputData,
  OutputNode,
  ToolConfig,
} from "./types";
import { isInput, isOutput } from "./types";

export const uid = () => crypto.randomUUID();

/** Fallback footprint for a node React Flow has not measured yet. */
const NODE_SIZE = { width: 300, height: 240 };
const GAP = 28;
/** Output cards render taller than the generic fallback because their text area starts at 260px. */
const OUTPUT_CARD_SIZE = { width: 300, height: 336 };
const OUTPUT_INPUT_GAP = 120;
const OUTPUT_CLUSTER_X_STEP = 72;
const OUTPUT_CLUSTER_Y_STEP = 64;
const OUTPUT_SET_GAP = 56;

export type Box = { x: number; y: number; w: number; h: number };

export const boxOf = (n: GraphNode): Box => ({
  x: n.position.x,
  y: n.position.y,
  w: n.measured?.width ?? NODE_SIZE.width,
  h: n.measured?.height ?? NODE_SIZE.height,
});

/**
 * The first spot at or below-right of `desired` that clears everything in `taken`. Scans across
 * then wraps down, so a new node lands beside its neighbours rather than on top of them.
 */
export function freeSpot(
  desired: { x: number; y: number },
  taken: Box[],
  size = NODE_SIZE,
  direction: "down" | "right" = "down",
): { x: number; y: number } {
  const hits = (x: number, y: number) =>
    taken.some(
      (b) =>
        x < b.x + b.w + GAP &&
        x + size.width + GAP > b.x &&
        y < b.y + b.h + GAP &&
        y + size.height + GAP > b.y,
    );

  // Ordinary additions stack downward. Output clusters already fan down/up internally, so their
  // later sets stay close by trying the next horizontal slot first.
  for (let primary = 0; primary < (direction === "right" ? 30 : 12); primary++) {
    for (let secondary = 0; secondary < (direction === "right" ? 12 : 30); secondary++) {
      const col = direction === "right" ? secondary : primary;
      const row = direction === "right" ? primary : secondary;
      const x = desired.x + col * (size.width + GAP);
      const y = desired.y + row * (size.height + GAP);
      if (!hits(x, y)) return { x, y };
    }
  }
  return desired;
}

const byId = (nodes: GraphNode[]) => new Map(nodes.map((n) => [n.id, n]));

/**
 * Which input nodes must run before this one.
 *
 * An artifact resolves to the step that produced it, so `step -> artifact -> step` orders those
 * steps just as a pre-wired `step -> step` does.
 *
 * Skipped steps never run, so they are neither scheduled nor waited on — depending on one
 * would otherwise deadlock its dependents and read as a false cycle.
 */
export function inputDependencies(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Set<string>> {
  const map = byId(nodes);
  const incoming = new Map<string, string[]>();
  for (const e of edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);

  const deps = new Map<string, Set<string>>();
  for (const n of nodes) {
    if (isInput(n) && n.data.performInference !== false && !n.data.skipped) deps.set(n.id, new Set());
  }

  for (const [id, set] of deps) {
    const visited = new Set<string>();
    const visit = (sourceId: string) => {
      if (visited.has(sourceId)) return;
      visited.add(sourceId);
      const source = map.get(sourceId);
      if (!source) return;

      if (isInput(source)) {
        if (source.data.skipped) return;
        if (source.data.performInference === false) {
          for (const upstreamId of incoming.get(source.id) ?? []) visit(upstreamId);
        } else {
          set.add(source.id);
        }
      } else if (isOutput(source)) {
        const producer = map.get(source.data.sourceId);
        if (producer && isInput(producer) && producer.data.performInference !== false && !producer.data.skipped) {
          set.add(producer.id);
        }
      }
    };
    for (const sourceId of incoming.get(id) ?? []) visit(sourceId);
  }
  return deps;
}

/** Kahn's algorithm over the input nodes. `cycle` lists ids that could never become ready. */
export function topoOrder(nodes: GraphNode[], edges: GraphEdge[]): { order: string[]; cycle: string[] } {
  const deps = inputDependencies(nodes, edges);
  const remaining = new Map([...deps].map(([id, set]) => [id, new Set(set)]));
  const order: string[] = [];

  // Steps with no ordering between them run in the order they were created. Canvas position
  // deliberately plays no part: dragging a node about should never resequence a run.
  const created = new Map(nodes.map((n, i) => [n.id, i]));
  const ready = () =>
    [...remaining]
      .filter(([, d]) => d.size === 0)
      .map(([id]) => id)
      .sort((a, b) => created.get(a)! - created.get(b)!);

  for (let next = ready(); next.length; next = ready()) {
    const id = next[0];
    remaining.delete(id);
    order.push(id);
    for (const set of remaining.values()) set.delete(id);
  }

  return { order, cycle: [...remaining.keys()] };
}

export type ContextBlock = { label: string; text: string };

export type InheritedInput = {
  context: ContextBlock[];
  attachments: Attachment[];
  files: InputFile[];
  links: { id: string; url: string }[];
  workspaces: { id: string; path: string }[];
};

/** Context-only input nodes flow through their own input and resources without being executed. */
export function resolveInheritedInput(inputId: string, nodes: GraphNode[], edges: GraphEdge[]): InheritedInput {
  const map = byId(nodes);
  const incoming = new Map<string, string[]>();
  for (const edge of edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  const result: InheritedInput = { context: [], attachments: [], files: [], links: [], workspaces: [] };
  const visited = new Set<string>();

  const visit = (sourceId: string) => {
    if (visited.has(sourceId)) return;
    visited.add(sourceId);
    const source = map.get(sourceId);
    if (!source || source.data.skipped) return;

    if (isOutput(source)) {
      result.context.push({ label: source.data.sourceLabel, text: source.data.text });
      return;
    }
    if (source.data.performInference !== false) return;

    for (const upstreamId of incoming.get(source.id) ?? []) visit(upstreamId);
    if (source.data.prompt.trim()) result.context.push({ label: source.data.label, text: source.data.prompt });
    result.attachments.push(...(source.data.attachments ?? []));
    result.files.push(...(source.data.files ?? []));
    result.links.push(...(source.data.links ?? []));
    result.workspaces.push(...(source.data.workspaces ?? []));
  };

  const direct = incoming.get(inputId) ?? [];
  const outputIds = direct.filter((id) => {
    const node = map.get(id);
    return node && isOutput(node);
  }).sort((a, b) => {
    const left = map.get(a);
    const right = map.get(b);
    return left && right && isOutput(left) && isOutput(right) ? left.data.createdAt - right.data.createdAt : 0;
  });
  for (const sourceId of [...outputIds, ...direct.filter((id) => !outputIds.includes(id))]) visit(sourceId);
  return result;
}

/** Everything flowing into an input node along its incoming edges, in stable visual order. */
export function resolveContext(inputId: string, nodes: GraphNode[], edges: GraphEdge[]): ContextBlock[] {
  return resolveInheritedInput(inputId, nodes, edges).context;
}

/** The exact string sent to the model: upstream context first, then this step's own prompt. */
export function composePrompt(context: ContextBlock[], prompt: string): string {
  if (!context.length) return prompt;
  const blocks = context
    .map((c) => `<context from="${c.label}">\n${c.text}\n</context>`)
    .join("\n\n");
  return `${blocks}\n\n${prompt}`;
}

/** The tools a step will offer the model on this run. Skipping the step withholds them all. */
export function resolveTools(step: InputNode): ToolConfig[] {
  return step.data.tools ?? [];
}

/** The system prompt: the role, phrased as one, followed by the step's own instructions. */
export function composeSystem(
  role?: string,
  instructions?: string,
  attachments?: Attachment[],
): string | undefined {
  const documents = (attachments ?? [])
    .filter((a) => a.text.trim())
    .map((a) => `<document name="${a.name}">\n${a.text.trim()}\n</document>`);

  const parts = [
    role?.trim() ? `Your role is: ${role.trim()}` : "",
    instructions?.trim() ?? "",
    ...documents,
  ];
  const system = parts.filter(Boolean).join("\n\n");
  return system || undefined;
}

/** Extract complete model-emitted thinking blocks without altering their tags or contents. */
export function splitThinking(text: string): { thinking: string; answer: string } {
  const blocks: string[] = [];
  const answer = text.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, (block) => {
    blocks.push(block);
    return "";
  });
  return { thinking: blocks.join("\n\n"), answer: blocks.length ? answer.trim() : text };
}

export type RunResult = Omit<OutputData, "sourceId" | "sourceLabel" | "createdAt">;

/**
 * Record one execution: spawn a fresh artifact per result, point the producer at all of them,
 * and migrate the replaced artifacts' downstream edges onto the new set. Prior outputs stay on
 * the canvas, detached, holding their text.
 */
export function commitRun(
  nodes: GraphNode[],
  edges: GraphEdge[],
  producer: InputNode,
  results: RunResult[],
  options: { append?: boolean; preserveRoutes?: boolean; moveRoutes?: boolean } = {},
): { nodes: GraphNode[]; edges: GraphEdge[]; outputIds: string[] } {
  const existing = new Map(nodes.filter(isOutput).filter((n) => n.data.execId && n.data.kind !== "thinking").map((n) => [n.data.execId, n.id]));
  const unique = results.filter((result, i) => !result.execId || (!existing.has(result.execId) && results.findIndex((r) => r.execId === result.execId) === i));
  if (!unique.length) return { nodes, edges, outputIds: results.map((r) => existing.get(r.execId)!).filter(Boolean) };
  const map = byId(nodes);

  const activeRootIds = new Set(
    edges
      .filter((e) => e.source === producer.id)
      .map((e) => map.get(e.target))
      .filter((n): n is OutputNode => !!n && isOutput(n))
      .map((n) => n.id),
  );

  const activeOutputIds = new Set([...activeRootIds].filter((id) => {
    const node = map.get(id);
    return node && isOutput(node) && node.data.kind !== "thinking";
  }));
  for (const edge of edges) {
    const root = map.get(edge.source);
    const target = map.get(edge.target);
    if (activeRootIds.has(edge.source) && root && isOutput(root) && root.data.kind === "thinking"
        && target && isOutput(target) && target.data.kind !== "thinking") activeOutputIds.add(target.id);
  }

  // Pre-wiring materialises once there is an artifact: a step pointing straight at another step
  // gets that edge re-pointed at the new artifact.
  const prewired = edges.filter((e) => {
    const t = map.get(e.target);
    return e.source === producer.id && !!t && isInput(t);
  });
  const inherited = edges.filter((e) => activeOutputIds.has(e.source));

  // Reserve one compact footprint for the fan-out, then fan cards rightward in an alternating
  // down/up formation. Siblings deliberately overlap like a hand of cards; unrelated nodes do
  // not. Existing nodes are never moved to make room.
  const relatedOutputs = nodes.filter((node): node is OutputNode => isOutput(node) && node.data.sourceId === producer.id);
  const legacySets = new Set(relatedOutputs.map((node) => node.data.outputSetId ?? `legacy:${node.data.createdAt}`));
  const greatestSetIndex = relatedOutputs.reduce((greatest, node) =>
    Math.max(greatest, node.data.outputSetIndex ?? -1), -1);
  const outputSetIndex = Math.max(legacySets.size, greatestSetIndex + 1);
  const outputSetId = uid();
  // Sibling cards may overlap inside one set, but every historical set remains an obstacle to
  // the next set. This preserves the macro stagger without letting whole sets cover each other.
  const taken = nodes.map(boxOf);
  const beside = { x: producer.position.x + boxOf(producer).w + OUTPUT_INPUT_GAP, y: producer.position.y };
  const createdAt = Date.now();
  const parsed = unique.map((result) => ({ result, ...splitThinking(result.text) }));
  const offsets = parsed.map((_, index) => ({
    x: index * OUTPUT_CLUSTER_X_STEP,
    y: index === 0 ? 0 : (index % 2 ? 1 : -1) * Math.ceil(index / 2) * OUTPUT_CLUSTER_Y_STEP,
  }));
  const minY = Math.min(...offsets.map(({ y }) => y));
  const maxY = Math.max(...offsets.map(({ y }) => y));
  const clusterSize = {
    width: parsed.some(({ thinking }) => thinking)
      ? OUTPUT_CARD_SIZE.width * 2 + GAP + offsets.at(-1)!.x
      : OUTPUT_CARD_SIZE.width + offsets.at(-1)!.x,
    height: OUTPUT_CARD_SIZE.height + maxY - minY,
  };
  // Match the steep diagonal used inside a set. A small fixed Y offset made whole sets read as
  // one horizontal row once their non-overlapping X gap was applied.
  const outputSetYStep = clusterSize.height - OUTPUT_CLUSTER_Y_STEP;
  const outputSetColumn = Math.ceil(outputSetIndex / 2);
  const setOffset = {
    x: outputSetColumn * (clusterSize.width + OUTPUT_SET_GAP),
    y: outputSetIndex === 0
      ? 0
      : (outputSetIndex % 2 ? 1 : -1) * Math.ceil(outputSetIndex / 2) * outputSetYStep,
  };
  const cluster = freeSpot({
    x: beside.x + setOffset.x,
    y: beside.y + minY + setOffset.y,
  }, taken, clusterSize, "right");

  const thinkingNodes: OutputNode[] = [];
  const resultEdges: GraphEdge[] = [];
  const outputs: OutputNode[] = parsed.map(({ result, thinking, answer }, index) => {
    let source = producer.id;
    const row = { x: cluster.x + offsets[index].x, y: cluster.y + offsets[index].y - minY };
    let position = row;
    if (thinking) {
      const node: OutputNode = { id: uid(), type: "artifact", position: row, data: {
        kind: "thinking", outputSetId, outputSetIndex, text: thinking, sourceId: producer.id, sourceLabel: producer.data.label,
        model: result.model, effort: result.effort, createdAt, runId: result.runId,
      } };
      thinkingNodes.push(node);
      resultEdges.push({ id: uid(), source: producer.id, target: node.id });
      source = node.id;
      position = { x: row.x + OUTPUT_CARD_SIZE.width + GAP, y: row.y };
    }
    const id = uid();
    resultEdges.push({ id: uid(), source, target: id });
    return {
      id,
      type: "artifact",
      position,
      data: {
        ...result,
        outputSetId,
        outputSetIndex,
        text: answer,
        sourceId: producer.id,
        sourceLabel: producer.data.label,
        createdAt,
      },
    };
  });
  const stale = new Set((options.preserveRoutes ? [] : [
    ...(options.moveRoutes || !options.append ? inherited : []),
    ...prewired,
  ]).map((e) => e.id));
  const kept = edges.filter(
    (e) => !stale.has(e.id) && !(!options.append && e.source === producer.id && activeRootIds.has(e.target)),
  );

  // Every sibling of a fan-out feeds the same consumers, so a downstream step sees all N
  // candidates rather than only the first. Targets are collapsed to a set first, or re-running
  // an N-way fan-out would multiply the edges each time.
  const consumers = options.preserveRoutes ? [] : [...new Set([...inherited, ...prewired].map((e) => e.target))];
  const migrated: GraphEdge[] = outputs.flatMap((o) =>
    consumers.map((target) => ({ id: uid(), source: o.id, target })),
  );

  return {
    nodes: [...nodes, ...thinkingNodes, ...outputs],
    edges: [
      ...kept,
      ...resultEdges,
      ...migrated,
    ],
    outputIds: results.map((r) => existing.get(r.execId) ?? outputs[r.execId ? unique.findIndex((u) => u.execId === r.execId) : unique.indexOf(r)]?.id).filter((id): id is string => !!id),
  };
}
