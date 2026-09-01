import type {
  Attachment,
  GraphEdge,
  GraphNode,
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
): { x: number; y: number } {
  const hits = (x: number, y: number) =>
    taken.some(
      (b) =>
        x < b.x + b.w + GAP &&
        x + size.width + GAP > b.x &&
        y < b.y + b.h + GAP &&
        y + size.height + GAP > b.y,
    );

  // Column-major: the flow runs left to right, so alternatives stack downward before spilling
  // further right into the next step's space.
  for (let col = 0; col < 12; col++) {
    for (let row = 0; row < 30; row++) {
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
  for (const n of nodes) if (isInput(n) && !n.data.skipped) deps.set(n.id, new Set());

  for (const [id, set] of deps) {
    for (const sourceId of incoming.get(id) ?? []) {
      const source = map.get(sourceId);
      if (!source) continue;

      if (isInput(source)) {
        if (!source.data.skipped) set.add(source.id);
      } else if (isOutput(source)) {
        const producer = map.get(source.data.sourceId);
        if (producer && isInput(producer) && !producer.data.skipped) set.add(producer.id);
      }
    }
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

/** Everything flowing into an input node along its incoming edges, in stable visual order. */
export function resolveContext(inputId: string, nodes: GraphNode[], edges: GraphEdge[]): ContextBlock[] {
  const map = byId(nodes);
  return edges
    .filter((e) => e.target === inputId)
    .map((e) => map.get(e.source))
    .filter((n): n is OutputNode => !!n && isOutput(n) && !n.data.skipped)
    .sort((a, b) => a.data.createdAt - b.data.createdAt)
    .map((n) => ({ label: n.data.sourceLabel, text: n.data.text }));
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

export type RunResult = Omit<OutputData, "sourceId" | "sourceLabel" | "createdAt">;

/**
 * Record one execution: spawn a fresh artifact per result, point the producer at all of them,
 * and migrate the replaced artifacts' downstream edges onto the first. Prior outputs stay on
 * the canvas, detached, holding their text.
 */
export function commitRun(
  nodes: GraphNode[],
  edges: GraphEdge[],
  producer: InputNode,
  results: RunResult[],
): { nodes: GraphNode[]; edges: GraphEdge[]; outputIds: string[] } {
  const map = byId(nodes);

  const activeOutputIds = new Set(
    edges
      .filter((e) => e.source === producer.id)
      .map((e) => map.get(e.target))
      .filter((n): n is OutputNode => !!n && isOutput(n))
      .map((n) => n.id),
  );

  // Pre-wiring materialises once there is an artifact: a step pointing straight at another step
  // gets that edge re-pointed at the new artifact.
  const prewired = edges.filter((e) => {
    const t = map.get(e.target);
    return e.source === producer.id && !!t && isInput(t);
  });
  const inherited = edges.filter((e) => activeOutputIds.has(e.source));

  // Artifacts land beside the step, fanning down into whatever space is free. Existing nodes
  // are never moved to make room — a run should not rearrange the canvas under you.
  const taken = nodes.map(boxOf);
  const beside = { x: producer.position.x + boxOf(producer).w + GAP, y: producer.position.y };
  const createdAt = Date.now();

  const outputs: OutputNode[] = results.map((result) => {
    const position = freeSpot(beside, taken);
    taken.push({ x: position.x, y: position.y, w: NODE_SIZE.width, h: NODE_SIZE.height });
    return {
      id: uid(),
      type: "artifact",
      position,
      data: {
        ...result,
        sourceId: producer.id,
        sourceLabel: producer.data.label,
        createdAt,
      },
    };
  });
  const stale = new Set([...inherited, ...prewired].map((e) => e.id));
  const kept = edges.filter(
    (e) => !stale.has(e.id) && !(e.source === producer.id && activeOutputIds.has(e.target)),
  );

  // Every sibling of a fan-out feeds the same consumers, so a downstream step sees all N
  // candidates rather than only the first. Targets are collapsed to a set first, or re-running
  // an N-way fan-out would multiply the edges each time.
  const consumers = [...new Set([...inherited, ...prewired].map((e) => e.target))];
  const migrated: GraphEdge[] = outputs.flatMap((o) =>
    consumers.map((target) => ({ id: uid(), source: o.id, target })),
  );

  return {
    nodes: [...nodes, ...outputs],
    edges: [
      ...kept,
      ...outputs.map((o) => ({ id: uid(), source: producer.id, target: o.id })),
      ...migrated,
    ],
    outputIds: outputs.map((o) => o.id),
  };
}
