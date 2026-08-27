import type { GraphEdge, GraphNode, InputNode, OutputData, OutputNode, ToolNode } from "./types";
import { isInput, isOutput, isTool } from "./types";

export const uid = () => crypto.randomUUID();

const byId = (nodes: GraphNode[]) => new Map(nodes.map((n) => [n.id, n]));

/**
 * Which input nodes must run before this one. An input depends on another input either
 * directly (a pre-wired input -> input edge) or through one of its output artifacts.
 *
 * Skipped steps never run, so they are neither scheduled nor waited on — depending on one
 * would otherwise deadlock its dependents and read as a false cycle.
 */
export function inputDependencies(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Set<string>> {
  const map = byId(nodes);
  const deps = new Map<string, Set<string>>();
  for (const n of nodes) if (isInput(n) && !n.data.skipped) deps.set(n.id, new Set());

  for (const e of edges) {
    const target = map.get(e.target);
    const source = map.get(e.source);
    if (!target || !source || !isInput(target)) continue;

    if (isInput(source)) {
      if (!source.data.skipped) deps.get(target.id)?.add(source.id);
    } else if (isOutput(source)) {
      const producer = map.get(source.data.sourceId);
      if (producer && isInput(producer) && !producer.data.skipped) {
        deps.get(target.id)?.add(producer.id);
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

  // Stable ordering: among equally-ready nodes, run the topmost-then-leftmost first.
  const position = new Map(nodes.map((n) => [n.id, n.position]));
  const ready = () =>
    [...remaining]
      .filter(([, d]) => d.size === 0)
      .map(([id]) => id)
      .sort((a, b) => {
        const pa = position.get(a)!;
        const pb = position.get(b)!;
        return pa.y - pb.y || pa.x - pb.x;
      });

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

  // With tools attached the flow runs step -> tool -> artifact, so an artifact this step is
  // currently feeding may hang off one of its tools rather than off the step itself.
  const tools = resolveTools(producer.id, nodes, edges);
  const toolIds = new Set(tools.map((t) => t.id));
  const feedsArtifact = (e: GraphEdge) => e.source === producer.id || toolIds.has(e.source);

  const activeOutputIds = new Set(
    edges
      .filter(feedsArtifact)
      .map((e) => map.get(e.target))
      .filter((n): n is OutputNode => !!n && isOutput(n) && n.data.sourceId === producer.id)
      .map((n) => n.id),
  );

  // Pre-wired input -> input edges materialise into output -> input once there is an artifact.
  const prewired = edges.filter((e) => {
    const t = map.get(e.target);
    return e.source === producer.id && !!t && isInput(t);
  });
  const inherited = edges.filter((e) => activeOutputIds.has(e.source));

  const siblings = nodes.filter((n) => isOutput(n) && n.data.sourceId === producer.id).length;
  const createdAt = Date.now();
  const outputs: OutputNode[] = results.map((result, i) => ({
    id: uid(),
    type: "artifact",
    position: { x: producer.position.x + (siblings + i) * 330, y: producer.position.y + 260 },
    data: {
      ...result,
      sourceId: producer.id,
      sourceLabel: producer.data.label,
      createdAt,
    },
  }));
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
      // The artifact hangs off the tools when there are any, so the graph reads as a chain
      // rather than a triangle of step -> tool, step -> artifact, tool -> artifact.
      ...outputs.flatMap((o) =>
        tools.length
          ? tools.map((t) => ({ id: uid(), source: t.id, target: o.id }))
          : [{ id: uid(), source: producer.id, target: o.id }],
      ),
      ...migrated,
    ],
    outputIds: outputs.map((o) => o.id),
  };
}
