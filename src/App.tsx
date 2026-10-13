import { WorkspaceChangesPanel } from "./WorkspaceChangesPanel";
import { AdaptiveEdge } from "./AdaptiveEdge";
import { SandboxConfigPanel } from "./SandboxConfigPanel";
import { GraphSync, type SaveState } from "./graphSync";
import { rememberExecutions, pendingExecutions, forgetExecutions, cancelPending } from "./pendingExecutions";
import { reportTraceEvent } from "./traceEvents";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  MarkerType,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  type Connection,
  type IsValidConnection,
} from "@xyflow/react";

import { fetchSettings, fetchModels, runStep, toolSpec, waitForExecution, cancelExecution, type TraceStep, type Provider, type PlatformSettings } from "./api";
import { Icon } from "./icons";
import { DEFAULT_LOOP_LIMIT, normalizeLoopLimit } from "./loop";
import { SettingsPanel } from "./SettingsPanel";
import { TracePanel } from "./TracePanel";
import {
  boxOf,
  commitRun,
  composePrompt,
  composeSystem,
  freeSpot,
  resolveInheritedInput,
  resolveTools,
  topoOrder,
  uid,
} from "./graph";
import { GraphActionsContext } from "./nodes/context";
import { CommentNodeView } from "./nodes/CommentNodeView";
import { ContextNodeView } from "./nodes/ContextNodeView";
import { InputNodeView } from "./nodes/InputNodeView";
import { OutputNodeView } from "./nodes/OutputNodeView";
import {
  isComment,
  isContext,
  isInput,
  isOutput,
  type CommentData,
  type CommentNode,
  type ContextData,
  type ContextNode,
  type GraphEdge,
  type GraphEdgeData,
  type GraphNode,
  type InputData,
  type InputNode,
  type LoopOutputMode,
  type OutputData,
  type ToolConfig,
} from "./types";

const nodeTypes = { step: InputNodeView, context: ContextNodeView, artifact: OutputNodeView, comment: CommentNodeView };
const edgeTypes = { adaptive: AdaptiveEdge };

function CanvasControlIcon({ kind }: { kind: "in" | "out" | "fit" }) {
  if (kind === "in") return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M32 18.133H18.133V32h-4.266V18.133H0v-4.266h13.867V0h4.266v13.867H32z" /></svg>;
  if (kind === "out") return <svg viewBox="0 0 32 5" aria-hidden="true"><path d="M0 0h32v4.2H0z" /></svg>;
  return <svg viewBox="0 0 32 30" aria-hidden="true"><path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" /></svg>;
}

/** Edges are directed and that direction decides run order, so every edge shows an arrowhead. */
const MARKER = { type: MarkerType.ArrowClosed, width: 18, height: 18, color: "#8b93a3" };
const SELECTED_MARKER = { ...MARKER, color: "#e6e8ec" };
const STORAGE_KEY = "mnemonic.graph.v1";
const DEFAULT_MODEL = "gpt-5";
export const MAX_OUTPUTS = 8;
/** Mirrors DEFAULT_TOOL_ROUNDS on the server. */
export const DEFAULT_ROUNDS = 12;
export const DEFAULT_TIMEOUT_SEC = 300;

type Snapshot = { nodes: GraphNode[]; edges: GraphEdge[] };

function newInput(model: string, position: { x: number; y: number }): InputNode {
  return {
    id: uid(),
    type: "step",
    position,
    data: {
      collapsed: true,
      label: "Unnamed",
      model,
      effort: "off",
      outputs: 1,
      maxRounds: DEFAULT_ROUNDS,
      timeoutSec: DEFAULT_TIMEOUT_SEC,
      loopLimit: DEFAULT_LOOP_LIMIT,
      loopOutputMode: "last",
      status: "idle",
    },
  };
}

function newContext(position: { x: number; y: number }): ContextNode {
  return { id: uid(), type: "context", position, data: {
    label: "Unnamed", role: "", instructions: "", prompt: "", workspaces: [], attachments: [], files: [], links: [],
  } };
}

function newComment(position: { x: number; y: number }): CommentNode {
  return { id: uid(), type: "comment", position, data: { author: "", text: "", createdAt: Date.now(), replies: [] } };
}

/** Graphs saved before the rename still carry React Flow's reserved type names. */
function migrateNode(n: GraphNode): GraphNode {
  const legacy: Record<string, string> = { input: "step", output: "artifact" };
  const typed = legacy[n.type as string] ? ({ ...n, type: legacy[n.type as string] } as GraphNode) : n;
  if (!isInput(typed)) return typed;
  // Preserve old graphs while bringing their former placeholder label forward.
  return { ...typed, data: {
    ...typed.data,
    ...(typeof typed.data.outputs !== "number" ? { outputs: 1 } : {}),
    ...(typed.data.label === "Name this step" ? { label: "Unnamed" } : {}),
  } };
}

/**
 * Tools used to be nodes wired to a step. Fold each one into the steps it was attached to and
 * drop it, so an existing graph keeps its configured tools rather than losing them.
 */
function migrateToolNodes({ nodes, edges }: Snapshot): Snapshot {
  const toolNodes = nodes.filter((n) => (n.type as string) === "tool");
  if (!toolNodes.length) return { nodes, edges };

  const toolIds = new Set(toolNodes.map((n) => n.id));
  const attachedTo = (toolId: string) =>
    edges
      .filter((e) => e.source === toolId || e.target === toolId)
      .map((e) => (e.source === toolId ? e.target : e.source))
      .filter((other) => !toolIds.has(other));

  const adopted = new Map<string, ToolConfig[]>();
  for (const tool of toolNodes) {
    const config = { id: tool.id, ...(tool.data as unknown as Omit<ToolConfig, "id">) };
    for (const stepId of new Set(attachedTo(tool.id))) {
      adopted.set(stepId, [...(adopted.get(stepId) ?? []), config]);
    }
  }

  return {
    nodes: nodes
      .filter((n) => !toolIds.has(n.id))
      .map((n) =>
        isInput(n) && adopted.has(n.id)
          ? { ...n, data: { ...n.data, tools: [...(n.data.tools ?? []), ...adopted.get(n.id)!] } }
          : n,
      ),
    // Edges that touched a tool carried no context, so they simply go.
    edges: edges.filter((e) => !toolIds.has(e.source) && !toolIds.has(e.target)),
  };
}

/** Split the prompt/resources formerly stored on a step into explicit Context nodes. */
function migrateContextNodes(snapshot: Snapshot): Snapshot {
  const nodes: GraphNode[] = [];
  const edges = [...snapshot.edges];

  for (const node of snapshot.nodes) {
    if (!isInput(node)) {
      nodes.push(node);
      continue;
    }

    const { performInference, role, instructions, prompt, workspaces, attachments, files, links, ...inference } = node.data;
    const contextData: ContextData = {
      label: node.data.label || "Unnamed",
      role: role ?? "",
      instructions: instructions ?? "",
      prompt: prompt ?? "",
      workspaces: workspaces ?? [],
      attachments: attachments ?? [],
      files: files ?? [],
      links: links ?? [],
    };

    if (performInference === false) {
      nodes.push({ id: node.id, type: "context", position: node.position, data: contextData });
      continue;
    }

    nodes.push({ ...node, data: inference });
    const hasContext = !!(contextData.role?.trim() || contextData.instructions?.trim() || contextData.prompt.trim()
      || contextData.workspaces?.length || contextData.attachments?.length || contextData.files?.length || contextData.links?.length);
    if (!hasContext) continue;

    const contextNode = newContext({ x: node.position.x - 360, y: node.position.y });
    contextNode.data = contextData;
    nodes.push(contextNode);
    edges.push({ id: uid(), source: contextNode.id, target: node.id });
  }

  return { nodes, edges };
}

function migrateSnapshot(snapshot: Snapshot): Snapshot {
  const renamed = { ...snapshot, nodes: snapshot.nodes.map(migrateNode) };
  return migrateContextNodes(migrateToolNodes(renamed));
}

function loadSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.nodes) || !Array.isArray(parsed?.edges)) return null;
    return migrateSnapshot(parsed as Snapshot);
  } catch {
    return null;
  }
}

const seed = loadSnapshot() ?? {
  nodes: [newInput(DEFAULT_MODEL, { x: 260, y: 80 })],
  edges: [],
};

function Canvas() {
  const [nodes, setReactNodes] = useNodesState<GraphNode>(seed.nodes);
  const [edges, setReactEdges] = useEdgesState<GraphEdge>(seed.edges);
  // Every graph edit updates the live snapshot synchronously so concurrent completions cannot
  // overwrite edits queued for a later React render.
  const live = useRef<Snapshot>({ nodes, edges });
  const setNodes = useCallback((value: GraphNode[] | ((nodes: GraphNode[]) => GraphNode[])) => {
    const next = typeof value === "function" ? value(live.current.nodes) : value;
    live.current = { ...live.current, nodes: next };
    setReactNodes(next);
  }, [setReactNodes]);
  const setEdges = useCallback((value: GraphEdge[] | ((edges: GraphEdge[]) => GraphEdge[])) => {
    const next = typeof value === "function" ? value(live.current.edges) : value;
    live.current = { ...live.current, edges: next };
    setReactEdges(next);
  }, [setReactEdges]);
  const onNodesChange = useCallback((changes: NodeChange<GraphNode>[]) => setNodes((current) => applyNodeChanges(changes, current)), [setNodes]);
  const onEdgesChange = useCallback((changes: EdgeChange<GraphEdge>[]) => setEdges((current) => applyEdgeChanges(changes, current)), [setEdges]);
  const updateEdgeRoute = useCallback((id: string, route?: Partial<NonNullable<GraphEdgeData["route"]>>) => {
    setEdges((current) => current.map((edge) => edge.id === id ? {
      ...edge,
      data: {
        ...(edge.data ?? {}),
        control: undefined,
        route: route ? { ...(edge.data?.route ?? {}), ...route } : undefined,
      },
    } : edge));
  }, [setEdges]);
  const [providerSettings, setProviderSettings] = useState<PlatformSettings | null>(null);
  const [providerModels, setProviderModels] = useState<Partial<Record<Provider, string[]>>>({});
  const defaultProvider = providerSettings?.provider ?? "openai";
  const providerRefresh = useRef(0);
  const refreshProviders = useCallback((settings: PlatformSettings) => {
    setProviderSettings(settings);
    const revision = ++providerRefresh.current;
    for (const config of settings.providers?.filter((p) => p.configured) ?? [settings]) {
      void fetchModels(config.provider).then((models) => {
        if (revision === providerRefresh.current) {
          setProviderModels((current) => ({ ...current, [config.provider]: models }));
        }
      });
    }
  }, []);
  const [stepped, setStepped] = useState<string[]>([]);
  const steppedRef = useRef<string[]>([]);
  const abort = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);
  const nodeRuns = useRef(new Map<string, AbortController>());
  const [activeNodeIds, setActiveNodeIds] = useState<string[]>([]);
  const runningAny = running || activeNodeIds.length > 0;
  const pendingAtMount = useRef(pendingExecutions());
  const [notice, setNotice] = useState<string | null>(null);
  // One side panel at a time; the canvas keeps the rest of the width.
  const [panel, setPanel] = useState<"trace" | "settings" | "sandbox" | "changes" | null>(null);
  const { screenToFlowPosition, zoomIn, zoomOut, fitView: fitCanvas } = useReactFlow();
  const minZoomReached = useStore((state) => state.transform[2] <= state.minZoom);
  const maxZoomReached = useStore((state) => state.transform[2] >= state.maxZoom);
  const wrapper = useRef<HTMLDivElement>(null);

  const [changesId, setChangesId] = useState<string | null>(null);
  const openWorkspaceChanges = useCallback((id: string) => { setChangesId(id); setPanel("changes"); }, []);
  const [sandboxNodeId, setSandboxNodeId] = useState<string | null>(null);
  const openSandboxConfig = useCallback((id: string) => { setSandboxNodeId(id); setPanel("sandbox"); }, []);
  const sandboxNode = nodes.find((node) => node.id === sandboxNodeId && isInput(node)) as InputNode | undefined;


  useEffect(() => {
    steppedRef.current = stepped;
  }, [stepped]);

  useEffect(() => {
    const minimap = wrapper.current?.querySelector(".react-flow__minimap-svg");
    minimap?.removeAttribute("aria-labelledby");
    minimap?.setAttribute("aria-label", "Mini Map");
  }, []);

  useEffect(() => {
    fetchSettings().then(refreshProviders).catch(() => {});
  }, [refreshProviders]);

  useEffect(() => {
    if (!providerSettings) return;
    if (!nodes.some((node) => isInput(node) && !node.data.provider)) return;
    setNodes((current) => current.map((node) => isInput(node) && !node.data.provider
      ? { ...node, data: { ...node.data, provider: defaultProvider } } : node));
  }, [providerSettings, defaultProvider, setNodes, nodes]);

  const sync = useRef<GraphSync | null>(null);
  const publish = useCallback(
    (snap: Snapshot) => {
      live.current = snap;
      sync.current?.update(snap);
      setNodes(snap.nodes);
      setEdges(snap.edges);
    },
    [setNodes, setEdges],
  );

  const [saveState, setSaveState] = useState<SaveState>({ label: "Checking", ready: false });
  useEffect(() => {
    const writer = new GraphSync(live.current, (snapshot) => publish(migrateSnapshot(snapshot)), setSaveState);
    sync.current = writer;
    void writer.start();
    return () => writer.stop();
  }, [publish]);
  useEffect(() => { sync.current?.update({ nodes, edges }); }, [nodes, edges]);

  const patchStatus = (snap: Snapshot, id: string, patch: Partial<InputData>): Snapshot => ({
    ...snap,
    nodes: snap.nodes.map((n) => (n.id === id && isInput(n) ? { ...n, data: { ...n.data, ...patch } } : n)),
  });

  const updateInput = useCallback(
    (id: string, patch: Partial<InputData> | ((data: InputData) => Partial<InputData>)) => {
      setNodes((current) =>
        current.map((n) =>
          n.id === id && isInput(n)
            ? { ...n, data: { ...n.data, ...(typeof patch === "function" ? patch(n.data) : patch) } }
            : n,
        ),
      );
    },
    [setNodes],
  );

  const updateContext = useCallback(
    (id: string, patch: Partial<ContextData> | ((data: ContextData) => Partial<ContextData>)) => {
      setNodes((current) => current.map((node) =>
        node.id === id && isContext(node)
          ? { ...node, data: { ...node.data, ...(typeof patch === "function" ? patch(node.data) : patch) } }
          : node));
    },
    [setNodes],
  );

  const updateOutput = useCallback(
    (id: string, patch: Partial<OutputData>) => {
      setNodes((current) =>
        current.map((n) => (n.id === id && isOutput(n) ? { ...n, data: { ...n.data, ...patch } } : n)),
      );
    },
    [setNodes],
  );

  const updateComment = useCallback(
    (id: string, patch: Partial<CommentData> | ((data: CommentData) => Partial<CommentData>)) => {
      setNodes((current) => current.map((node) =>
        node.id === id && isComment(node)
          ? { ...node, data: { ...node.data, ...(typeof patch === "function" ? patch(node.data) : patch) } }
          : node));
    },
    [setNodes],
  );

  const stopNode = useCallback((id: string) => {
    nodeRuns.current.get(id)?.abort();
    cancelPending(id).forEach((entry) => void cancelExecution(entry));
  }, []);

  useEffect(() => {
    for (const id of nodeRuns.current.keys()) {
      const node = nodes.find((node) => node.id === id);
      if (!node) stopNode(id);
    }
  }, [nodes, stopNode]);

  const removeNode = useCallback(
    (id: string) => {
      setNodes((current) => current.filter((n) => n.id !== id));
      setEdges((current) => current.filter((e) => e.source !== id && e.target !== id));
    },
    [setNodes, setEdges],
  );

  /** Execute a single input node against a working snapshot and return the snapshot it produced. */
  const executeNode = useCallback(
    async (snap: Snapshot, id: string, trace?: { runId: string; kind: "run" | "next" | "step"; seq: number }, options: { signal?: AbortSignal; preserveRoutes?: boolean; loopOutputMode?: LoopOutputMode } = {}): Promise<Snapshot> => {
      const producer = snap.nodes.find((n) => n.id === id);
      if (!producer || !isInput(producer)) return snap;

      const count = Math.min(MAX_OUTPUTS, Math.max(1, producer.data.outputs ?? 1));
      const runTrace = trace ?? { runId: uid(), kind: "step" as const, seq: 0 };
      const executions = Array.from({ length: count }, () => ({ ...runTrace, execId: uid() }));
      const lastExecution = { runId: executions[0].runId, execIds: executions.map((e) => e.execId),
        startedMs: Date.now(), timeoutSec: producer.data.timeoutSec || 300 };
      let working = patchStatus(snap, id, { status: "running", error: undefined, lastExecution });
      publish(working);

      const inherited = resolveInheritedInput(id, working.nodes, working.edges);
      const context = inherited.context;
      const input = composePrompt(context, "");
      if (!input.trim()) {
        const next = patchStatus(working, id, { status: "error", error: "This inference has no connected input context.", lastExecution: undefined });
        publish(next);
        return next;
      }
      const instructions = composeSystem(inherited.roles, inherited.instructions, inherited.attachments);
      const tools = resolveTools(producer).map(toolSpec);

      const group = uid();
      rememberExecutions(executions.map((execution) => ({ ...execution, nodeId: id, label: producer.data.label, effort: producer.data.effort, group,
        preserveRoutes: options.preserveRoutes,
        loopOutputMode: options.loopOutputMode,
        deadline: Date.now() + ((producer.data.timeoutSec || 300) + (producer.data.sandbox ? 720 : 60)) * 1000 })));
      const settled = await Promise.allSettled(
        executions.map((execution) =>
          runStep(
            {
              provider: producer.data.provider ?? defaultProvider,
              model: producer.data.model,
              effort: producer.data.effort,
              input,
              instructions,
              tools,
              maxRounds: producer.data.maxRounds,
              timeoutSec: producer.data.timeoutSec,
              files: inherited.files.map(({ name, mime, dataUrl }) => ({ name, mime, dataUrl })),
              links: inherited.links.map((l) => l.url).filter((url) => url.trim()),
              workspaceTools: producer.data.workspaceTools,
              workspaces: inherited.workspaces.map((w) => w.path).filter((p) => p.trim()),
              sandbox: (producer.data.provider === "huggingface" && providerSettings?.providers?.find((p) => p.provider === "huggingface")?.runLocally) || producer.data.sandbox,
              sandboxConfig: producer.data.sandboxConfig,
              useGpu: producer.data.provider === "huggingface" && !!producer.data.useGpu,
              ...(execution
                ? {
                    trace: {
                      ...execution,
                      nodeId: id,
                      label: producer.data.label,
                      context,
                      loopOutputMode: options.loopOutputMode,
                    },
                  }
                : {}),
            },
            options.signal,
          ),
        ),
      );

      const successfulExecutions = executions.filter((_, i) => settled[i].status === "fulfilled");
      let committedIds: string[] = [];
      working = live.current;
      const done = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failed = settled.flatMap((r) => (r.status === "rejected" ? [r.reason as Error] : []));

      // Deleting a running producer must not resurrect it or attach orphaned outputs.
      if (!working.nodes.some((node) => node.id === id)) {
        forgetExecutions(executions.map((e) => e.execId));
        return working;
      }
      const cancelled = failed.some((f) => f.message === "cancelled");
      if (cancelled && !((options.preserveRoutes || options.loopOutputMode) && done.length)) {
        successfulExecutions.forEach((execution) => reportTraceEvent(execution, "delivery.cancelled", { reason: "fan-out cancelled before graph commit" }));
        working = patchStatus(working, id, { status: "idle", error: undefined });
      } else if (!done.length) {
        working = patchStatus(working, id, { status: "error", error: failed[0]?.message ?? "run failed" });
      } else {
        try {
          const committed = commitRun(
            working.nodes,
            working.edges,
            producer,
            done.map((result, i) => ({
              execId: successfulExecutions[i]?.execId,
              runId: successfulExecutions[i]?.runId,
              model: result.model,
              effort: producer.data.effort,
              text: result.text,
              usage: result.usage,
              toolCalls: result.toolCalls,
              workspaceChanges: result.workspaceChanges,
            })),
            options.loopOutputMode
              ? { append: true, moveRoutes: options.loopOutputMode === "last" }
              : options.preserveRoutes ? { append: true, preserveRoutes: true } : {},
          );
          committedIds = committed.outputIds;
          working = patchStatus({ nodes: committed.nodes, edges: committed.edges }, id, {
            status: "done",
            // A partial fan-out still commits what succeeded, but says what did not.
            error: !cancelled && failed.length
              ? `${failed.length} of ${count} generations failed: ${failed[0].message}`
              : undefined,
          });
        } catch (err) {
          successfulExecutions.forEach((execution) => reportTraceEvent(execution, "graph.failed", { error: (err as Error).message }));
          throw err;
        }
      }

      working = patchStatus(working, id, { lastExecution: { ...lastExecution, finishedMs: Date.now() } });
      try { publish(working); }
      catch (err) {
        successfulExecutions.forEach((execution) => reportTraceEvent(execution, "graph.failed", { error: (err as Error).message }));
        throw err;
      }
      // Cache outputs before removing recovery records, so refresh cannot lose the handoff.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(working));
      committedIds.forEach((outputId, i) => reportTraceEvent(successfulExecutions[i], "graph.committed", { outputId }));
      if (cancelled) forgetExecutions(executions.map((e) => e.execId));
      else forgetExecutions(executions.filter((_, i) => settled[i].status === "fulfilled" || (settled[i] as PromiseRejectedResult).reason?.terminal).map((e) => e.execId));
      return working;
    },
    [publish, defaultProvider, providerSettings],
  );

  const addSavedOutput = useCallback(async (step: TraceStep) => {
    if (step.status !== "ok") throw new Error("This execution has no completed output.");
    if (live.current.nodes.some((n) => isOutput(n) && n.data.execId === step.execId)) return;
    const producer = live.current.nodes.find((n) => n.id === step.nodeId && isInput(n)) as InputNode | undefined;
    if (!producer) throw new Error("The source step is no longer on this graph.");
    const committed = commitRun(live.current.nodes, live.current.edges, producer, [{ execId: step.execId, runId: step.runId,
      model: step.servedModel ?? step.requestedModel, effort: step.effort as InputData["effort"], text: step.outputText ?? "",
      workspaceChanges: step.params?.workspaceChanges, usage: step.usage ?? undefined, toolCalls: step.toolCalls ?? undefined }], { append: true });
    publish({ nodes: committed.nodes, edges: committed.edges });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(live.current));
    forgetExecutions([step.execId]);
    reportTraceEvent(step, "graph.committed", { outputId: committed.outputIds[0], recovered: true });
  }, [publish]);

  useEffect(() => {
    if (!saveState.ready || saveState.label === "Conflict") return;
    const pending = pendingAtMount.current.filter((entry) => !entry.cancelled);
    if (!pending.length) return;
    let stopped = false;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    const recover = async () => {
      const groups = [...new Set(pending.map((entry) => entry.group))];
      for (const group of groups) {
        const entries = pending.filter((entry) => entry.group === group);
        const settled = await Promise.allSettled(entries.map(async (entry) => {
          if (live.current.nodes.some((n) => isOutput(n) && n.data.execId === entry.execId)) return null;
          reportTraceEvent(entry, "delivery.recovering", { afterRefresh: true });
          const result = await waitForExecution(entry, { signal: controller.signal, deadline: Math.max(entry.deadline, Date.now() + 15_000) });
          return { ...result, execId: entry.execId, runId: entry.runId, effort: entry.effort };
        }));
        if (stopped) return;
        const results = settled.flatMap((s) => s.status === "fulfilled" && s.value ? [s.value] : []);
        const failures = settled.filter((s) => s.status === "rejected");
        forgetExecutions(entries.filter((_, i) => settled[i].status === "rejected" && (settled[i] as PromiseRejectedResult).reason?.terminal).map((e) => e.execId));
        const producer = live.current.nodes.find((n) => n.id === entries[0].nodeId && isInput(n)) as InputNode | undefined;
        if (producer && results.length && !controller.signal.aborted) {
          const loopOutputMode = entries.find((entry) => entry.loopOutputMode)?.loopOutputMode;
          const moveRoutes = loopOutputMode ? loopOutputMode === "last" : entries.some((entry) => entry.moveRoutes);
          const committed = commitRun(live.current.nodes, live.current.edges, producer, results, {
            append: true,
            moveRoutes,
            preserveRoutes: !loopOutputMode && !moveRoutes && entries.some((entry) => entry.preserveRoutes),
          });
          publish(patchStatus({ nodes: committed.nodes, edges: committed.edges }, producer.id, { status: "done",
            error: failures.length ? `${failures.length} executions failed; inspect Trace Logs.` : undefined }));
          localStorage.setItem(STORAGE_KEY, JSON.stringify(live.current));
          results.forEach((result, i) => reportTraceEvent(result, "graph.committed", { outputId: committed.outputIds[i], recovered: true }));
          forgetExecutions(results.map((r) => r.execId));
        } else if (producer && failures.length) {
          publish(patchStatus(live.current, producer.id, { status: controller.signal.aborted ? "idle" : "error", error: controller.signal.aborted ? undefined : "Could not recover every output. Inspect Trace Logs." }));
        }
        forgetExecutions(entries.filter((entry) => live.current.nodes.some((n) => isOutput(n) && n.data.execId === entry.execId)).map((e) => e.execId));
      }
      if (!stopped) { pendingAtMount.current = []; setRunning(false); }
    };
    void recover().catch((err) => { if (!stopped) { setNotice((err as Error).message); setRunning(false); } });
    return () => { stopped = true; controller.abort(); };
    // Run recovery once hydration resolves, not on each save/status change.
  }, [saveState.ready, saveState.label === "Conflict", publish]);



  const runOne = useCallback(
    async (id: string, trace?: { runId: string; kind: "run" | "next" | "step"; seq: number }) => {
      if (nodeRuns.current.has(id) || pendingAtMount.current.some((entry) => entry.nodeId === id && !entry.cancelled)) return;
      const initial = live.current.nodes.find((node) => node.id === id);
      if (!initial || !isInput(initial)) return;
      const looping = !!initial.data.loop && trace?.kind !== "run";
      const controller = new AbortController();
      nodeRuns.current.set(id, controller);
      setActiveNodeIds([...nodeRuns.current.keys()]);
      setNotice(null);
      const runId = trace?.runId ?? uid();
      let seq = trace?.seq ?? 0;
      let iterations = 0;
      try {
        do {
          const current = live.current.nodes.find((node) => node.id === id);
          if (controller.signal.aborted || !current || !isInput(current)) break;
          await executeNode(live.current, id, { runId, kind: trace?.kind ?? "step", seq: seq++ },
            { signal: controller.signal, loopOutputMode: looping ? current.data.loopOutputMode ?? "last" : undefined });
          iterations++;
          setStepped((s) => s.includes(id) ? s : [...s, id]);
          const next = live.current.nodes.find((node) => node.id === id);
          if (!looping || controller.signal.aborted || !next || !isInput(next) || !next.data.loop || next.data.error) break;
          if (iterations >= normalizeLoopLimit(next.data.loopLimit)) {
            publish(patchStatus(live.current, id, { loop: false }));
            break;
          }
          // Yield between iterations so graph edits, Stop, and other nodes remain responsive.
          await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, 250);
            controller.signal.addEventListener("abort", done, { once: true });
          });
        } while (!controller.signal.aborted && (live.current.nodes.find((node) => node.id === id)?.data as InputData | undefined)?.loop);
      } catch (err) {
        const message = (err as Error).message;
        publish(patchStatus(live.current, id, { status: controller.signal.aborted ? "idle" : "error",
          error: controller.signal.aborted ? undefined : message }));
        if (!controller.signal.aborted) setNotice(`Run failed: ${message}`);
      } finally {
        nodeRuns.current.delete(id);
        setActiveNodeIds([...nodeRuns.current.keys()]);
      }
    },
    [executeNode, publish],
  );

  /**
   * Aborts the in-flight request and clears the run state a cancelled step would leave. The
   * controller is deliberately kept: the run loop checks its signal to decide whether to carry
   * on to the next step, and clearing it would read as "not aborted".
   */
  const stopRun = useCallback(() => {
    cancelPending().forEach((entry) => void cancelExecution(entry));
    abort.current?.abort();
    nodeRuns.current.forEach((controller) => controller.abort());
    setNotice(null);
  }, []);

  const clearCanvas = useCallback(() => {
    if (!window.confirm("Are you sure you want to clear the entire canvas?")) return;
    publish({ nodes: [], edges: [] });
    steppedRef.current = [];
    setStepped([]);
    setNotice(null);
    setChangesId(null);
    setSandboxNodeId(null);
    setPanel((current) => current === "changes" || current === "sandbox" ? null : current);
  }, [publish]);

  /** Centre of what the user is currently looking at, in canvas coordinates. */
  const viewportSpot = useCallback(() => {
    const rect = wrapper.current?.getBoundingClientRect();
    const centre = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const flow = screenToFlowPosition(centre);
    return { x: flow.x - 150, y: flow.y - 120 };
  }, [screenToFlowPosition]);

  const addStep = useCallback(() => {
    setNodes((current) => {
      const position = freeSpot(viewportSpot(), current.map(boxOf));
      const provider = providerSettings?.providers?.find((p) => p.configured)?.provider ?? defaultProvider;
      const node = newInput(providerModels[provider]?.[0] ?? "", position);
      node.data.provider = provider;
      return [...current, node];
    });
  }, [providerModels, providerSettings, defaultProvider, setNodes, viewportSpot]);

  const addContext = useCallback(() => {
    setNodes((current) => [...current, newContext(freeSpot(viewportSpot(), current.map(boxOf)))]);
  }, [setNodes, viewportSpot]);

  const addComment = useCallback(() => {
    setNodes((current) => [...current, newComment(freeSpot(viewportSpot(), current.map(boxOf)))]);
  }, [setNodes, viewportSpot]);

  /** Context-bearing nodes feed contexts/inferences; only inferences produce artifacts. */
  const isValidConnection = useCallback<IsValidConnection<GraphEdge>>(
    (conn) => {
      const source = nodes.find((n) => n.id === conn.source);
      const target = nodes.find((n) => n.id === conn.target);
      if (!source || !target || source.id === target.id) return false;
      if (isComment(source)) return isInput(target) || isContext(target);
      if (isComment(target)) return false;
      if (isContext(source)) return isInput(target) || isContext(target);
      if (isContext(target)) return true;
      return !(isOutput(source) && isOutput(target));
    },
    [nodes],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      setEdges((current) => {
        const source = live.current.nodes.find((n) => n.id === conn.source);
        const target = live.current.nodes.find((n) => n.id === conn.target);
        // An input marks exactly one output as its current context, so a new one replaces the old.
        const pruned =
          source && target && isInput(source) && isOutput(target)
            ? current.filter(
                (e) =>
                  !(e.source === source.id && live.current.nodes.some((n) => n.id === e.target && isOutput(n))),
              )
            : current;
        return addEdge({ ...conn, id: uid() }, pruned);
      });
    },
    [setEdges],
  );

  // Dropping a dragged endpoint on empty canvas deletes the edge. React Flow otherwise snaps
  // it back, so the drop is only a reconnect if onReconnect fired between start and end.
  const reconnected = useRef(true);

  const onReconnectStart = useCallback(() => {
    reconnected.current = false;
  }, []);

  /**
   * Reversing an edge by dragging means moving the source end specifically, which is easy to get
   * wrong; a double-click flips it outright.
   */
  const onEdgeDoubleClick = useCallback(
    (_event: React.MouseEvent, edge: GraphEdge) => {
      const flipped = { source: edge.target, target: edge.source, sourceHandle: null, targetHandle: null };
      if (!isValidConnection(flipped)) {
        setNotice("That edge cannot point the other way.");
        return;
      }
      setEdges((current) =>
        current.map((e) => (e.id === edge.id ? { ...e, source: edge.target, target: edge.source } : e)),
      );
    },
    [isValidConnection, setEdges],
  );

  const onReconnect = useCallback(
    (oldEdge: GraphEdge, conn: Connection) => {
      reconnected.current = true;
      setEdges((current) => reconnectEdge(oldEdge, conn, current));
    },
    [setEdges],
  );

  const onReconnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, edge: GraphEdge) => {
      if (!reconnected.current) setEdges((current) => current.filter((e) => e.id !== edge.id));
      reconnected.current = true;
    },
    [setEdges],
  );

  const exportGraph = useCallback(() => {
    const blob = new Blob([JSON.stringify(live.current, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mnemonic-graph-${new Date().toISOString().slice(0, 19)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const importGraph = useCallback(
    (file: File) => {
      file.text().then((text) => {
        try {
          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed?.nodes) || !Array.isArray(parsed?.edges)) throw new Error("bad shape");
          publish(migrateSnapshot({ nodes: parsed.nodes, edges: parsed.edges }));
          setStepped([]);
          setNotice(null);
        } catch {
          setNotice("That file is not a mnemonic graph export.");
        }
      });
    },
    [publish],
  );

  // Applied at render rather than on creation, so edges made anywhere - by hand, by a run, or
  // loaded from an older graph - all show direction, and the marker stays out of exported JSON.
  const shownEdges = useMemo(() => edges.map((e) => ({
    ...e,
    type: "adaptive",
    markerEnd: e.selected ? SELECTED_MARKER : MARKER,
  })), [edges]);

  /** The schedule: edges decide it, position only breaks ties between independent steps. */
  const runOrder = useMemo(() => topoOrder(nodes, edges).order, [nodes, edges]);

  /** The step Next would run: first in that order that has not been stepped yet. */
  const currentId = useMemo(
    () => runOrder.find((nodeId) => !stepped.includes(nodeId)) ?? null,
    [runOrder, stepped],
  );

  const workspaceCounts = useMemo(() => Object.fromEntries(nodes.filter(isInput).map((node) => [
    node.id,
    resolveInheritedInput(node.id, nodes, edges).workspaces.filter((workspace) => workspace.path.trim()).length,
  ])), [nodes, edges]);

  const actions = useMemo(
    () => ({ activeNodeIds, stopNode, openWorkspaceChanges, openSandboxConfig, providerModels, providerSettings, defaultProvider, currentId, workspaceCounts, updateInput, updateContext, updateOutput, updateComment, updateEdgeRoute, runOne, removeNode }),
    [activeNodeIds, stopNode, openWorkspaceChanges, openSandboxConfig, providerModels, providerSettings, defaultProvider, currentId, workspaceCounts, updateInput, updateContext, updateOutput, updateComment, updateEdgeRoute, runOne, removeNode],
  );

  return (
    <GraphActionsContext.Provider value={actions}>
      <div className="app">
        <header className="toolbar">
          <div className="bar-left">
            <div className="brand">
              mnemonic
              <span className="header-divider">|</span>
              <span className="save-status" data-state={saveState.label} role="status" title={saveState.error}>
                <span className="save-status-label">{saveState.label}</span>
              </span>
            </div>
          </div>

          <div className="bar-right">
            <button className="node-create create-context" onClick={addContext}>
              <Icon name="page" /> <span>Context</span>
            </button>
            <button className="node-create create-step" onClick={addStep}>
              <Icon name="graph" /> <span>Inference</span>
            </button>
            <button className="node-create create-comment" onClick={addComment}>
              <Icon name="pencil" /> Comment
            </button>
            <button className="tinted tint-err" onClick={runningAny ? stopRun : clearCanvas}>
              <Icon name={runningAny ? "stop" : "trash"} /> {runningAny ? "STOP" : "Clear"}
            </button>
            <button className="icon-only" aria-label="Trace Logs"
              onClick={() => setPanel((p) => (p === "trace" ? null : "trace"))}>
              <Icon name="list" />
            </button>
            <button className="icon-only" onClick={exportGraph} aria-label="Export">
              <Icon name="download" />
            </button>
            <label className="file icon-only">
              <Icon name="upload" />
              <input
                type="file"
                accept="application/json"
                title=""
                aria-label="Import"
                disabled={runningAny}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importGraph(f);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              className="icon-only"
              onClick={() => setPanel((p) => (p === "settings" ? null : "settings"))}
              aria-label="Settings"
            >
              <Icon name="gear" />
            </button>
          </div>
        </header>

        {saveState.label === "Conflict" && (
          <div className="save-conflict">
            <span className="save-status-detail">{saveState.error}</span>
            <div className="save-status-actions">
              <button onClick={() => void sync.current?.resolve("local")}>Keep local edits</button>
              <button disabled={runningAny} onClick={() => void sync.current?.resolve("remote")}>Load saved graph</button>
            </div>
          </div>
        )}

        {notice && (
          <div className="notice" onClick={() => setNotice(null)}>
            {notice}
          </div>
        )}

        <div className="workspace">
          <div className="canvas" ref={wrapper}>
            <ReactFlow
              nodes={nodes}
              edges={shownEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgeDoubleClick={onEdgeDoubleClick}
              onReconnectStart={onReconnectStart}
              onReconnect={onReconnect}
              onReconnectEnd={onReconnectEnd}
              isValidConnection={isValidConnection}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              panOnDrag
              autoPanOnNodeDrag={false}
              nodeDragThreshold={0}
              connectionDragThreshold={0}
              connectionRadius={44}
              minZoom={0.1}
              fitView
              proOptions={{ hideAttribution: false }}
            >
              <Background gap={20} />
              <Controls showZoom={false} showFitView={false} showInteractive={false}>
                <ControlButton className="react-flow__controls-zoomin" aria-label="Zoom In"
                  disabled={maxZoomReached} onClick={() => void zoomIn()}>
                  <CanvasControlIcon kind="in" />
                </ControlButton>
                <ControlButton className="react-flow__controls-zoomout" aria-label="Zoom Out"
                  disabled={minZoomReached} onClick={() => void zoomOut()}>
                  <CanvasControlIcon kind="out" />
                </ControlButton>
                <ControlButton className="react-flow__controls-fitview" aria-label="Fit View"
                  onClick={() => void fitCanvas()}>
                  <CanvasControlIcon kind="fit" />
                </ControlButton>
              </Controls>
              <MiniMap
                ariaLabel=""
                pannable
                zoomable
                bgColor="var(--panel)"
                maskColor="rgba(15, 17, 21, 0.72)"
                nodeColor={(n) => isInput(n as GraphNode) ? "#6ea8fe" : isContext(n as GraphNode) ? "#5fd08a" : isComment(n as GraphNode) ? "#ffd100" : "#62417e"}
                nodeStrokeWidth={0}
              />
            </ReactFlow>
          </div>

          {panel === "trace" && <TracePanel onClose={() => setPanel(null)} onRecover={addSavedOutput} outputExecIds={nodes.filter(isOutput).map((n) => n.data.execId).filter((id): id is string => !!id)} />}
          {panel === "changes" && changesId && <WorkspaceChangesPanel key={changesId} id={changesId} onClose={() => setPanel(null)} />}
          {panel === "sandbox" && sandboxNode && <SandboxConfigPanel key={sandboxNode.id} node={sandboxNode} onClose={() => setPanel(null)} />}
          {panel === "settings" && <SettingsPanel onClose={() => setPanel(null)} onSaved={() => { void fetchSettings().then(refreshProviders); }} />}
        </div>
      </div>
    </GraphActionsContext.Provider>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
