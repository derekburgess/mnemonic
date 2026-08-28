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

import { fetchModels, runStep, toolSpec } from "./api";
import { Icon } from "./icons";
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
import { ToolNodeView } from "./nodes/ToolNodeView";
import { OutputNodeView } from "./nodes/OutputNodeView";
import {
  isInput,
  isOutput,
  isTool,
  type GraphEdge,
  type GraphNode,
  type InputData,
  type InputNode,
  type ToolData,
} from "./types";

const nodeTypes = { step: InputNodeView, artifact: OutputNodeView, tool: ToolNodeView };

/** Edges are directed and that direction decides run order, so every edge shows an arrowhead. */
const MARKER = { type: MarkerType.ArrowClosed, width: 18, height: 18, color: "#8b93a3" };
const STORAGE_KEY = "mnemonic.graph.v1";
const DEFAULT_MODEL = "gpt-5";
export const MAX_OUTPUTS = 8;

type Snapshot = { nodes: GraphNode[]; edges: GraphEdge[] };

function newInput(model: string, index: number, position: { x: number; y: number }): InputNode {
  return {
    id: uid(),
    type: "step",
    position,
    data: {
      label: `Step ${index}`,
      model,
      effort: "off",
      role: "",
      instructions: "",
      prompt: "",
      outputs: 1,
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

function newTool(index: number, position: { x: number; y: number }): GraphNode {
  return {
    id: uid(),
    type: "tool",
    position,
    data: { label: `Tool ${index}`, kind: "web_search", contextSize: "medium" },
  } as GraphNode;
}

function loadSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.nodes) || !Array.isArray(parsed?.edges)) return null;
    return { ...parsed, nodes: parsed.nodes.map(migrateNode) } as Snapshot;
  } catch {
    return null;
  }
}

const seed = loadSnapshot() ?? {
  nodes: [newInput(DEFAULT_MODEL, 1, { x: 260, y: 80 })],
  edges: [],
};

function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>(seed.edges);
  const [models, setModels] = useState<string[]>([DEFAULT_MODEL]);
  const [stepped, setStepped] = useState<string[]>([]);
  const steppedRef = useRef<string[]>([]);
  const abort = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const { screenToFlowPosition } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

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
    fetchModels().then(setModels);
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, edges }));
  }, [nodes, edges]);

  const publish = useCallback(
    (snap: Snapshot) => {
      live.current = snap;
      setNodes(snap.nodes);
      setEdges(snap.edges);
    },
    [setNodes, setEdges],
  );

  const patchStatus = (snap: Snapshot, id: string, patch: Partial<InputData>): Snapshot => ({
    ...snap,
    nodes: snap.nodes.map((n) => (n.id === id && isInput(n) ? { ...n, data: { ...n.data, ...patch } } : n)),
  });

  const updateInput = useCallback(
    (id: string, patch: Partial<InputData>) => {
      setNodes((current) =>
        current.map((n) => (n.id === id && isInput(n) ? { ...n, data: { ...n.data, ...patch } } : n)),
      );
    },
    [setNodes],
  );

  const updateTool = useCallback(
    (id: string, patch: Partial<ToolData>) => {
      setNodes((current) =>
        current.map((n) => (n.id === id && isTool(n) ? { ...n, data: { ...n.data, ...patch } } : n)),
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
        const next = patchStatus(snap, id, { status: "error", error: "This step has no input text." });
        publish(next);
        return next;
      }

      let working = patchStatus(snap, id, { status: "running", error: undefined });
      publish(working);

      const context = resolveContext(id, working.nodes, working.edges);
      const input = composePrompt(context, producer.data.prompt);
      const instructions = composeSystem(producer.data.role, producer.data.instructions);
      const tools = resolveTools(id, working.nodes, working.edges).map(toolSpec);

      const count = Math.min(MAX_OUTPUTS, Math.max(1, producer.data.outputs ?? 1));
      const settled = await Promise.allSettled(
        Array.from({ length: count }, () =>
          runStep(
            {
              model: producer.data.model,
              effort: producer.data.effort,
              input,
              instructions,
              tools,
              ...(trace
                ? {
                    trace: {
                      ...trace,
                      execId: uid(),
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

      const done = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failed = settled.flatMap((r) => (r.status === "rejected" ? [r.reason as Error] : []));

      const cancelled = failed.some((f) => f.message === "cancelled");
      if (cancelled) {
        working = patchStatus(working, id, { status: "idle", error: undefined });
      } else if (!done.length) {
        working = patchStatus(working, id, { status: "error", error: failed[0]?.message ?? "run failed" });
      } else {
        const committed = commitRun(
          working.nodes,
          working.edges,
          producer,
          done.map((result) => ({
            model: result.model,
            effort: producer.data.effort,
            text: result.text,
            usage: result.usage,
            toolCalls: result.toolCalls,
          })),
        );
        working = patchStatus({ nodes: committed.nodes, edges: committed.edges }, id, {
          status: "done",
          // A partial fan-out still commits what succeeded, but says what did not.
          error: failed.length
            ? `${failed.length} of ${count} generations failed: ${failed[0].message}`
            : undefined,
        });
      }

      publish(working);
      return working;
    },
    [publish],
  );

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

    abort.current = new AbortController();
    setRunning(true);
    setNotice(null);
    setStepped([]);

    try {
      const runId = uid();
      let snap = live.current;
      for (const [seq, id] of order.entries()) {
        if (abort.current?.signal.aborted) break;
        snap = await executeNode(snap, id, { runId, kind: "run", seq });
        setStepped((s) => [...s, id]);
      }
    } catch (err) {
      setNotice(`Run failed: ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, [executeNode, running]);

  const runNext = useCallback(async () => {
    if (running) return;
    const { order, cycle } = topoOrder(live.current.nodes, live.current.edges);
    if (cycle.length) {
      setNotice(`Cycle detected — ${cycle.length} step(s) can never become ready. Break the loop and retry.`);
      return;
    }
    const next = order.find((id) => !steppedRef.current.includes(id));
    if (!next) {
      setNotice(order.length ? "End of graph. Reset to step through again." : "Nothing to run — add a step first.");
      return;
    }

    abort.current = new AbortController();
    setRunning(true);
    setNotice(null);
    try {
      await executeNode(live.current, next, {
        runId: uid(),
        kind: "next",
        seq: steppedRef.current.length,
      });
      setStepped((s) => [...s, next]);
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
      const count = current.filter(isInput).length;
      const position = freeSpot(viewportSpot(), current.map(boxOf));
      return [...current, newInput(models[0] ?? DEFAULT_MODEL, count + 1, position)];
    });
  }, [models, setNodes, viewportSpot]);

  const addTool = useCallback(() => {
    setNodes((current) => {
      const count = current.filter(isTool).length;
      return [...current, newTool(count + 1, freeSpot(viewportSpot(), current.map(boxOf)))];
    });
  }, [setNodes, viewportSpot]);

  /**
   * Back to the top of the graph: the cursor, and the per-step run state with it. Never
   * disabled — it is also the way out of a run that is taking too long or has wedged.
   */
  const resetRun = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setRunning(false);
    setStepped([]);
    steppedRef.current = [];
    setNotice(null);
    setNodes((current) =>
      current.map((n) =>
        isInput(n) && (n.data.status !== "idle" || n.data.error)
          ? { ...n, data: { ...n.data, status: "idle" as const, error: undefined } }
          : n,
      ),
    );
  }, [setNodes]);

  const clearOutputs = useCallback(() => {
    const keep = new Set(live.current.nodes.filter((n) => !isOutput(n)).map((n) => n.id));
    publish({
      nodes: live.current.nodes.filter((n) => keep.has(n.id)),
      edges: live.current.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    });
    setStepped([]);
  }, [publish]);

  /** Outputs feed inputs, inputs feed outputs. Output -> output would carry no context. */
  const isValidConnection = useCallback<IsValidConnection<GraphEdge>>(
    (conn) => {
      const source = nodes.find((n) => n.id === conn.source);
      const target = nodes.find((n) => n.id === conn.target);
      if (!source || !target || source.id === target.id) return false;
      // A tool attaches to a step, or to an artifact as provenance; direction is meaningless.
      if (isTool(source)) return isInput(target) || isOutput(target);
      if (isTool(target)) return isInput(source) || isOutput(source);
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
          publish({ nodes: parsed.nodes.map(migrateNode), edges: parsed.edges });
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
    () => ({ models, currentId, runOrder, updateInput, updateTool, runOne, removeNode, setSkipped }),
    [models, currentId, runOrder, updateInput, updateTool, runOne, removeNode, setSkipped],
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

          <div className="bar-center">
            <button onClick={addStep}>
              <Icon name="page" /> Step
            </button>
            <button onClick={addTool}>
              <Icon name="gear" /> Tool
            </button>
            <span className="gap" />
            <button className="tinted tint-ok" onClick={runNext} disabled={running}>
              <Icon name="forward" /> Next
            </button>
            <button className="primary" onClick={runAll} disabled={running}>
              <Icon name="play" /> {running ? "Running…" : "Run"}
            </button>
            <button className="tinted tint-warn" onClick={resetRun}>
              <Icon name="refresh" /> Reset
            </button>
            <span className="gap" />
            <button className="tinted tint-err" onClick={clearOutputs} disabled={running}>
              <Icon name="trash" /> Clear outputs
            </button>
          </div>

          <div className="bar-right">
            <button onClick={() => setTraceOpen(true)}>Trace</button>
            <button onClick={exportGraph}>Export</button>
            <label className="file">
              Import
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
          </div>
        </header>

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
                nodeColor={(n) =>
                  isInput(n as GraphNode) ? "#6ea8fe" : isTool(n as GraphNode) ? "#c69cf0" : "#3a4150"
                }
                nodeStrokeWidth={0}
              />
            </ReactFlow>
          </div>

          {traceOpen && <TracePanel onClose={() => setTraceOpen(false)} />}
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
