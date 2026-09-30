import { SandboxConfigPanel } from "./SandboxConfigPanel";
import { GraphSync, type SaveState } from "./graphSync";
import { rememberExecutions, pendingExecutions, forgetExecutions, cancelPending } from "./pendingExecutions";
import { reportTraceEvent } from "./traceEvents";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  MarkerType,
  addEdge,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type IsValidConnection,
} from "@xyflow/react";

import { fetchSettings, fetchModels, runStep, toolSpec, waitForExecution, cancelExecution, type TraceStep, type Provider, type PlatformSettings } from "./api";
import { Icon } from "./icons";
import { SettingsPanel } from "./SettingsPanel";
import { TracePanel } from "./TracePanel";
import {
  boxOf,
  commitRun,
  composePrompt,
  composeSystem,
  freeSpot,
  resolveContext,
  resolveTools,
  topoOrder,
  uid,
} from "./graph";
import { GraphActionsContext } from "./nodes/context";
import { InputNodeView } from "./nodes/InputNodeView";
import { OutputNodeView } from "./nodes/OutputNodeView";
import {
  isInput,
  isOutput,
  type GraphEdge,
  type GraphNode,
  type InputData,
  type InputNode,
  type OutputData,
  type ToolConfig,
} from "./types";

const nodeTypes = { step: InputNodeView, artifact: OutputNodeView };

/** Edges are directed and that direction decides run order, so every edge shows an arrowhead. */
const MARKER = { type: MarkerType.ArrowClosed, width: 18, height: 18, color: "#8b93a3" };
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
      label: "Name this step",
      model,
      effort: "off",
      role: "",
      instructions: "",
      prompt: "",
      outputs: 1,
      maxRounds: DEFAULT_ROUNDS,
      timeoutSec: DEFAULT_TIMEOUT_SEC,
      status: "idle",
    },
  };
}

/** Graphs saved before the rename still carry React Flow's reserved type names. */
function migrateNode(n: GraphNode): GraphNode {
  const legacy: Record<string, string> = { input: "step", output: "artifact" };
  const typed = legacy[n.type as string] ? ({ ...n, type: legacy[n.type as string] } as GraphNode) : n;
  // Graphs saved before the fan-out parameter existed generate a single artifact.
  return isInput(typed) && typeof typed.data.outputs !== "number"
    ? { ...typed, data: { ...typed.data, outputs: 1 } }
    : typed;
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

function loadSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.nodes) || !Array.isArray(parsed?.edges)) return null;
    return migrateToolNodes({ ...parsed, nodes: parsed.nodes.map(migrateNode) } as Snapshot);
  } catch {
    return null;
  }
}

const seed = loadSnapshot() ?? {
  nodes: [newInput(DEFAULT_MODEL, { x: 260, y: 80 })],
  edges: [],
};

function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>(seed.edges);
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
  const pendingAtMount = useRef(pendingExecutions());
  const [notice, setNotice] = useState<string | null>(null);
  // One side panel at a time; the canvas keeps the rest of the width.
  const [panel, setPanel] = useState<"trace" | "settings" | "sandbox" | null>(null);
  const { screenToFlowPosition } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  const [sandboxNodeId, setSandboxNodeId] = useState<string | null>(null);
  const openSandboxConfig = useCallback((id: string) => { setSandboxNodeId(id); setPanel("sandbox"); }, []);
  const sandboxNode = nodes.find((node) => node.id === sandboxNodeId && isInput(node)) as InputNode | undefined;

  // The run loop awaits between steps, so it threads a working snapshot through by hand
  // rather than reading React state that has not committed yet.
  const live = useRef<Snapshot>({ nodes, edges });
  useEffect(() => {
    live.current = { nodes, edges };
  }, [nodes, edges]);

  useEffect(() => {
    steppedRef.current = stepped;
  }, [stepped]);

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
    const writer = new GraphSync(live.current, (snapshot) => publish(migrateToolNodes({ ...snapshot, nodes: snapshot.nodes.map(migrateNode) })), setSaveState);
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

  const updateOutput = useCallback(
    (id: string, patch: Partial<OutputData>) => {
      setNodes((current) =>
        current.map((n) => (n.id === id && isOutput(n) ? { ...n, data: { ...n.data, ...patch } } : n)),
      );
    },
    [setNodes],
  );

  const setSkipped = useCallback(
    (id: string, value: boolean) => {
      setNodes((current) =>
        current.map((n) => (n.id === id ? ({ ...n, data: { ...n.data, skipped: value } } as GraphNode) : n)),
      );
    },
    [setNodes],
  );

  const removeNode = useCallback(
    (id: string) => {
      setNodes((current) => current.filter((n) => n.id !== id));
      setEdges((current) => current.filter((e) => e.source !== id && e.target !== id));
    },
    [setNodes, setEdges],
  );

  /** Execute a single input node against a working snapshot and return the snapshot it produced. */
  const executeNode = useCallback(
    async (snap: Snapshot, id: string, trace?: { runId: string; kind: "run" | "next" | "step"; seq: number }): Promise<Snapshot> => {
      const producer = snap.nodes.find((n) => n.id === id);
      if (!producer || !isInput(producer) || producer.data.skipped) return snap;

      if (!producer.data.prompt.trim()) {
        const next = patchStatus(snap, id, { status: "error", error: "This step has no input text.", lastExecution: undefined });
        publish(next);
        return next;
      }

      const count = Math.min(MAX_OUTPUTS, Math.max(1, producer.data.outputs ?? 1));
      const runTrace = trace ?? { runId: uid(), kind: "step" as const, seq: 0 };
      const executions = Array.from({ length: count }, () => ({ ...runTrace, execId: uid() }));
      const lastExecution = { runId: executions[0].runId, execIds: executions.map((e) => e.execId),
        startedMs: Date.now(), timeoutSec: producer.data.timeoutSec || 300 };
      let working = patchStatus(snap, id, { status: "running", error: undefined, lastExecution });
      publish(working);

      const context = resolveContext(id, working.nodes, working.edges);
      const input = composePrompt(context, producer.data.prompt);
      const instructions = composeSystem(
        producer.data.role,
        producer.data.instructions,
        producer.data.attachments,
      );
      const tools = resolveTools(producer).map(toolSpec);

      const group = uid();
      rememberExecutions(executions.map((execution) => ({ ...execution, nodeId: id, label: producer.data.label, effort: producer.data.effort, group,
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
              files: producer.data.files?.map(({ name, mime, dataUrl }) => ({ name, mime, dataUrl })),
              links: producer.data.links?.map((l) => l.url).filter((url) => url.trim()),
              workspaces: producer.data.workspaces?.map((w) => w.path).filter((p) => p.trim()),
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
                    },
                  }
                : {}),
            },
            abort.current?.signal,
          ),
        ),
      );

      const successfulExecutions = executions.filter((_, i) => settled[i].status === "fulfilled");
      let committedIds: string[] = [];
      working = live.current;
      const done = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failed = settled.flatMap((r) => (r.status === "rejected" ? [r.reason as Error] : []));

      const cancelled = failed.some((f) => f.message === "cancelled");
      if (cancelled) {
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
            })),
          );
          committedIds = committed.outputIds;
          working = patchStatus({ nodes: committed.nodes, edges: committed.edges }, id, {
            status: "done",
            // A partial fan-out still commits what succeeded, but says what did not.
            error: failed.length
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
      usage: step.usage ?? undefined, toolCalls: step.toolCalls ?? undefined }], { append: true });
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
          const committed = commitRun(live.current.nodes, live.current.edges, producer, results, { append: true });
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
    async (id: string) => {
      if (running) return;
      abort.current = new AbortController();
      setRunning(true);
      setNotice(null);
      try {
        await executeNode(live.current, id, { runId: uid(), kind: "step", seq: 0 });
        setStepped((s) => (s.includes(id) ? s : [...s, id]));
      } catch (err) {
        setNotice(`Run failed: ${(err as Error).message}`);
      } finally {
        setRunning(false);
      }
    },
    [executeNode, running],
  );

  /**
   * Aborts the in-flight request and clears the run state a cancelled step would leave. The
   * controller is deliberately kept: the run loop checks its signal to decide whether to carry
   * on to the next step, and clearing it would read as "not aborted".
   */
  const stopRun = useCallback(() => {
    cancelPending().forEach((entry) => void cancelExecution(entry));
    abort.current?.abort();
    setNotice(null);
  }, []);

  const runAll = useCallback(async () => {
    if (running) return;
    const { order, cycle } = topoOrder(live.current.nodes, live.current.edges);
    if (cycle.length) {
      setNotice(`Cycle detected — ${cycle.length} step(s) can never become ready. Break the loop and retry.`);
      return;
    }
    if (!order.length) {
      setNotice("Nothing to run — add a step first.");
      return;
    }

    // Held locally so a later run replacing abort.current cannot make this loop miss its stop.
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setNotice(null);
    setStepped([]);

    try {
      const runId = uid();
      let snap = live.current;
      for (const [seq, id] of order.entries()) {
        if (controller.signal.aborted) break;
        snap = await executeNode(snap, id, { runId, kind: "run", seq });
        setStepped((s) => [...s, id]);
      }
    } catch (err) {
      setNotice(`Run failed: ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, [executeNode, running]);

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

  /** Outputs feed inputs, inputs feed outputs. Output -> output would carry no context. */
  const isValidConnection = useCallback<IsValidConnection<GraphEdge>>(
    (conn) => {
      const source = nodes.find((n) => n.id === conn.source);
      const target = nodes.find((n) => n.id === conn.target);
      if (!source || !target || source.id === target.id) return false;
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
          publish(migrateToolNodes({ nodes: parsed.nodes.map(migrateNode), edges: parsed.edges }));
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
  const shownEdges = useMemo(() => edges.map((e) => ({ ...e, markerEnd: MARKER })), [edges]);

  /** The schedule: edges decide it, position only breaks ties between independent steps. */
  const runOrder = useMemo(() => topoOrder(nodes, edges).order, [nodes, edges]);

  /** The step Next would run: first in that order that has not been stepped yet. */
  const currentId = useMemo(
    () => runOrder.find((nodeId) => !stepped.includes(nodeId)) ?? null,
    [runOrder, stepped],
  );

  const actions = useMemo(
    () => ({ openSandboxConfig, providerModels, providerSettings, defaultProvider, currentId, updateInput, updateOutput, runOne, removeNode, setSkipped }),
    [openSandboxConfig, providerModels, providerSettings, defaultProvider, currentId, updateInput, updateOutput, runOne, removeNode, setSkipped],
  );

  return (
    <GraphActionsContext.Provider value={actions}>
      <div className="app">
        <header className="toolbar">
          <div className="bar-left">
            <span className="brand">
              mnemonic
              <span className="tagline">| A visual context and orchestration graph</span>
            </span>
          </div>

          <div className="bar-right">
            <div className="save-status" data-state={saveState.label} role="status" title={saveState.error}>
              <span className="save-status-label">
                <span className="save-status-dot" aria-hidden="true" />
                {saveState.label}
              </span>
            </div>
            {running ? (
              <button className="tinted tint-err" onClick={stopRun}>
                <Icon name="stop" /> Stop
              </button>
            ) : (
              <button className="primary" onClick={runAll}>
                <Icon name="play" /> Run all
              </button>
            )}
            <button onClick={addStep} disabled={running}>
              <Icon name="page" /> Add Step
            </button>
            <button onClick={() => setPanel((p) => (p === "trace" ? null : "trace"))}>
              <Icon name="list" /> Trace Logs
            </button>
            <button onClick={exportGraph}>
              <Icon name="download" /> Export
            </button>
            <label className="file">
              <Icon name="upload" /> Import
              <input
                type="file"
                accept="application/json"
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
              title="Settings"
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
              <button onClick={() => void sync.current?.resolve("remote")}>Load saved graph</button>
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
              fitView
              proOptions={{ hideAttribution: false }}
            >
              <Background gap={20} />
              <Controls />
              <MiniMap
                pannable
                zoomable
                bgColor="var(--panel)"
                maskColor="rgba(15, 17, 21, 0.72)"
                nodeColor={(n) => (isInput(n as GraphNode) ? "#6ea8fe" : "#3a4150")}
                nodeStrokeWidth={0}
              />
            </ReactFlow>
          </div>

          {panel === "trace" && <TracePanel onClose={() => setPanel(null)} onRecover={addSavedOutput} outputExecIds={nodes.filter(isOutput).map((n) => n.data.execId).filter((id): id is string => !!id)} />}
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
