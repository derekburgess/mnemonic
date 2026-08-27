import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type IsValidConnection,
} from "@xyflow/react";

import { fetchModels, runStep, toolSpec } from "./api";
import { commitRun, composePrompt, composeSystem, resolveContext, resolveTools, topoOrder, uid } from "./graph";
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
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The run loop awaits between steps, so it threads a working snapshot through by hand
  // rather than reading React state that has not committed yet.
  const live = useRef<Snapshot>({ nodes, edges });
  useEffect(() => {
    live.current = { nodes, edges };
  }, [nodes, edges]);

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
    async (snap: Snapshot, id: string): Promise<Snapshot> => {
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
          runStep({
            model: producer.data.model,
            effort: producer.data.effort,
            input,
            instructions,
            tools,
          }),
        ),
      );

      const done = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failed = settled.flatMap((r) => (r.status === "rejected" ? [r.reason as Error] : []));

      if (!done.length) {
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
      setRunning(true);
      setNotice(null);
      await executeNode(live.current, id);
      setStepped((s) => (s.includes(id) ? s : [...s, id]));
      setRunning(false);
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

    setRunning(true);
    setNotice(null);
    setStepped([]);

    let snap = live.current;
    for (const id of order) {
      snap = await executeNode(snap, id);
      setStepped((s) => [...s, id]);
    }
    setRunning(false);
  }, [executeNode, running]);

  const runNext = useCallback(async () => {
    if (running) return;
    const { order, cycle } = topoOrder(live.current.nodes, live.current.edges);
    if (cycle.length) {
      setNotice(`Cycle detected — ${cycle.length} step(s) can never become ready. Break the loop and retry.`);
      return;
    }
    const next = order.find((id) => !stepped.includes(id));
    if (!next) {
      setNotice(order.length ? "End of graph. Reset to step through again." : "Nothing to run — add a step first.");
      return;
    }

    setRunning(true);
    setNotice(null);
    await executeNode(live.current, next);
    setStepped((s) => [...s, next]);
    setRunning(false);
  }, [executeNode, running, stepped]);

  const addStep = useCallback(() => {
    setNodes((current) => {
      const count = current.filter(isInput).length;
      return [...current, newInput(models[0] ?? DEFAULT_MODEL, count + 1, { x: 260 + count * 60, y: 80 + count * 40 })];
    });
  }, [models, setNodes]);

  const addTool = useCallback(() => {
    setNodes((current) => {
      const count = current.filter(isTool).length;
      return [...current, newTool(count + 1, { x: 640 + count * 60, y: 80 + count * 40 })];
    });
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

  /** The step Next would run: first in topological order that has not been stepped yet. */
  const currentId = useMemo(() => {
    const { order } = topoOrder(nodes, edges);
    return order.find((nodeId) => !stepped.includes(nodeId)) ?? null;
  }, [nodes, edges, stepped]);

  const actions = useMemo(
    () => ({ models, currentId, updateInput, updateTool, runOne, removeNode, setSkipped }),
    [models, currentId, updateInput, updateTool, runOne, removeNode, setSkipped],
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
            <button onClick={addStep}>+ Step</button>
            <button onClick={addTool}>+ Tool</button>
            <span className="gap" />
            <button className="tinted tint-ok" onClick={runNext} disabled={running}>
              Next
            </button>
            <button className="primary" onClick={runAll} disabled={running}>
              {running ? "Running…" : "Run"}
            </button>
            <button className="tinted tint-warn" onClick={() => setStepped([])} disabled={running}>
              Reset
            </button>
            <span className="gap" />
            <button className="tinted tint-err" onClick={clearOutputs} disabled={running}>
              Clear outputs
            </button>
          </div>

          <div className="bar-right">
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

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
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
