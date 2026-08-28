import type { GraphEdge, GraphNode, InputNode, OutputData, OutputNode, ToolNode } from "./types";
import { isInput, isOutput, isTool } from "./types";

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
 * Dependencies follow directed paths, walking back through whatever sits in between: an
 * artifact resolves to the step that produced it, and a tool is walked straight through, so
 * `step -> tool -> step` orders those steps just as `step -> step` does.
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
    const seen = new Set<string>([id]);
    const queue = [...(incoming.get(id) ?? [])];

    while (queue.length) {
      const sourceId = queue.shift()!;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const source = map.get(sourceId);
      if (!source) continue;

      if (isInput(source)) {
        if (!source.data.skipped) set.add(source.id);
        // A step is the end of the walk: its own dependencies are its business.
        continue;
      }

      if (isOutput(source)) {
        const producer = map.get(source.data.sourceId);
        if (producer && isInput(producer) && !producer.data.skipped) set.add(producer.id);
        continue;
      }

      // A tool contributes no ordering of its own; keep walking through it.
      queue.push(...(incoming.get(sourceId) ?? []));
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

/**
 * The tools wired to a step. Tool nodes are capabilities, not context: they carry no text and
 * take part in no scheduling, so the edge direction carries no meaning and either is accepted.
 */
export function resolveTools(inputId: string, nodes: GraphNode[], edges: GraphEdge[]): ToolNode[] {
  const map = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();

  return edges
    .flatMap((e) => {
      if (e.target === inputId) return [map.get(e.source)];
      if (e.source === inputId) return [map.get(e.target)];
      return [];
    })
    .filter((n): n is ToolNode => {
      if (!n || !isTool(n) || n.data.skipped || seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    });
}

/** The system prompt: the role, phrased as one, followed by the step's own instructions. */
export function composeSystem(role?: string, instructions?: string): string | undefined {
  const parts = [role?.trim() ? `Your role is: ${role.trim()}` : "", instructions?.trim() ?? ""];
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

  // Tools the step flows *into* (step -> tool, transitively). These sit between the step and
  // its artifact, so the artifact hangs off them and anything they feed is really consuming
  // this step's output rather than sharing its tool.
  const forwardTools: string[] = [];
  const walked = new Set<string>([producer.id]);
  const queue = [producer.id];
  while (queue.length) {
    const from = queue.shift()!;
    for (const e of edges) {
      if (e.source !== from || walked.has(e.target)) continue;
      const node = map.get(e.target);
      if (!node || !isTool(node) || node.data.skipped) continue;
      walked.add(e.target);
      forwardTools.push(e.target);
      queue.push(e.target);
    }
  }

  // Anything downstream of the step hangs off the last thing in that chain.
  const anchors = forwardTools.length ? forwardTools : [producer.id];
  const chain = new Set([producer.id, ...forwardTools]);
  const feedsArtifact = (e: GraphEdge) => chain.has(e.source);

  const activeOutputIds = new Set(
    edges
      .filter(feedsArtifact)
      .map((e) => map.get(e.target))
      .filter((n): n is OutputNode => !!n && isOutput(n) && n.data.sourceId === producer.id)
      .map((n) => n.id),
  );

  // Pre-wiring materialises once there is an artifact: a step (or a tool it flows into) that
  // points straight at another step gets that edge re-pointed at the new artifact, so
  // `step -> tool -> step` becomes `step -> tool -> artifact -> step`.
  const prewired = edges.filter((e) => {
    const t = map.get(e.target);
    return chain.has(e.source) && !!t && isInput(t);
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
  // A fan-out has no single successor, so the chain follows the first sibling by default.
  const heir = outputs[0].id;

  const stale = new Set([...inherited, ...prewired].map((e) => e.id));
  const kept = edges.filter(
    (e) => !stale.has(e.id) && !(feedsArtifact(e) && activeOutputIds.has(e.target)),
  );

  const migrated: GraphEdge[] = [...inherited, ...prewired].map((e) => ({
    ...e,
    id: uid(),
    source: heir,
  }));

  return {
    nodes: [...nodes, ...outputs],
    edges: [
      ...kept,
      // The artifact hangs off the end of the step's tool chain, so the graph reads as a chain
      // rather than a triangle of step -> tool, step -> artifact, tool -> artifact.
      ...outputs.flatMap((o) => anchors.map((a) => ({ id: uid(), source: a, target: o.id }))),
      ...migrated,
    ],
    outputIds: outputs.map((o) => o.id),
  };
}
