# mnemonic

A graph-based UI for building agent orchestrations as **context graphs**. You lay out steps on an
open canvas, wire them together, and run the graph — either all at once or one hop at a time.

## Quick start

Needs Node `^20.19` or `>=22.12` (Vite 8's floor).

```bash
npm install
cp .env.example .env      # add your OPENAI_API_KEY
npm run dev
```

`npm run dev` starts both halves together: the proxy on **:8787** and the UI on **:5173**. Open
<http://localhost:5173>. Vite proxies `/api` to the server, so there is nothing else to configure.

The API key lives only in the local proxy under `server/` and is never bundled into the browser.
Without one the UI still loads and the graph is fully editable; runs return a clear 401.

| Script | What it does |
| --- | --- |
| `npm run dev` | proxy + UI together, both watching |
| `npm run dev:server` | just the proxy (`tsx watch`, also watches `.env`) |
| `npm run dev:web` | just the Vite dev server |
| `npm run build` | typecheck and build the UI to `dist/` |
| `npm run typecheck` | types only, no emit |

Two things are created on first use and are gitignored: `.env`, and `data/mnemonic.duckdb` for the
run history.

## The model

There are three kinds of node: **steps**, **artifacts** and **tools**.

**Input nodes** are the steps. Each holds a model, a thinking level (`reasoning_effort`), an
**Output N** fan-out count, a **Role**, **Instructions**, and its own input text.

The model dropdown is populated from a live `/v1/models` call through the proxy, so it never goes
stale. The API has no notion of a deprecated model, so the proxy filters what it can: other
modalities (audio, image, realtime…) and purpose-built variants (codex, deep-research, search) are
dropped, dated snapshots are collapsed into their alias, and what is left is ordered newest first.

`Output N` generates N candidates from the same prompt in parallel, as N sibling artifacts. The
producer wires to all of them; any downstream chain follows the first. Rewire to whichever candidate
you prefer and re-run to continue from it. If some generations fail the step still commits the ones
that succeeded and reports how many did not.

**Output nodes** are immutable artifacts. Every run produces a *new* output node — outputs are never
overwritten, they accumulate on the canvas as a visible history.

### Skip

Every node kind has a **Skip** toggle. Skipping keeps the node on the canvas with its wiring
intact, but takes it out of play:

- a skipped **step** is not scheduled by `Run` or `Next`, and its own Run button is disabled;
- a skipped **artifact** is withheld from the context of everything downstream of it.

Dependents of a skipped step still run — they read whatever artifacts already exist. Skipping is how
you mute a branch, A/B a candidate, or park an expensive step without unwiring anything.

### Role and instructions

`Role` and `Instructions` compose into the step's system prompt, sent as the Responses API's
`instructions` field. The role is phrased for you and placed first:

```
Your role is: senior copy editor

Be terse. British spelling.
```

Either may be left empty; if both are, no system prompt is sent at all. These are step parameters,
not context — they are not affected by wiring and never appear in a downstream artifact.

## Tool nodes

A third node kind. Tools are **capabilities, not context**: wiring a tool to a step means "this
step may call this tool". Because tools carry no text and no ordering, the edge direction is
meaningless and either direction attaches it. They carry no text, produce no artifacts, and take
no part in scheduling. Skipping one withholds it from its steps. Whatever the model actually
invoked is recorded on the artifact the step produced.

With a tool attached the flow reads as a chain rather than the step feeding the artifact directly.
Pre-wire the shape you want and the first run materialises the artifact into the middle of it:

```
before a run:   [Step 1] -> [Tool] -> [Step 2]
after a run:    [Step 1] -> [Tool] -> (Artifact) -> [Step 2]
```

Only tools the step flows *into* (`step -> tool`) sit in that chain. A tool pointing at a step
(`tool -> step`) is an upstream capability, and the artifact hangs off the step itself.

| Kind | Runs where | Notes |
| --- | --- | --- |
| Web search | OpenAI, server-side | Context size, plus optional allowed-domain filter |
| MCP | This proxy | Streamable-HTTP or SSE servers, localhost included |
| Custom | This proxy, in `node:vm` | Your own JS, with `args` in scope |

### MCP

We are the MCP client. The proxy connects to the server, lists its tools for the picker, and
advertises the ones you select to the model as ordinary function tools; calls come back here and we
invoke them over MCP. Streamable HTTP is tried first and the older HTTP+SSE transport second, so
either style of server works. A bare host is probed at the usual mount paths, and a bind address
like `0.0.0.0` is rewritten to `127.0.0.1` so pasting the URL a server prints just works; the field
is updated with whatever URL actually connected.

That is why **private and localhost servers work** - OpenAI never connects to your server, so it
does not need to be publicly reachable. Tool names are namespaced `mcp_<label>_<tool>` so two
servers can expose the same name.

### Custom

The body runs with `args` in scope and whatever it returns becomes the tool result. `fetch`, `URL`
and `console` are available.

```js
const res = await fetch(`https://api.example.com/q?s=${args.query}`);
return await res.json();
```

> **`node:vm` is not a security boundary.** Custom tools run in this proxy's process with a 5s
> timeout. That is fine for code you wrote on your own machine; never expose this to input you do
> not control. Run each call in an isolated child process if that changes.

The model may make several rounds of tool calls; the loop stops after 6. Each round is one
request to the model, so a step that made five tool calls records six rounds in the trace - five
calls plus the final answer.

MCP calls are given a 5 minute timeout (the SDK's own default is 60s, short for tools that do real
work), reset whenever the server reports progress, with a 15 minute ceiling.

## The graph is stateless

Nothing is cached on a node. The edges *are* the program: a run derives everything from the graph
topology plus each step's parameters. An input node's prompt is composed as its incoming context
followed by its own text:

```
<context from="Step 1">
...upstream output...
</context>

...this step's input text...
```

### What happens on a re-run

Given `[Step A] → (Out1) → [Step B] → (Out2)`, running Step A again:

1. spawns a fresh `Out3` and moves A's edge onto it,
2. migrates `Out1`'s downstream edges to `Out3`, so `Step B` is now fed by `Out3`,
3. leaves `Out1` on the canvas, detached, with its text intact.

If the run covers Step B too, B re-executes against the new context and spawns its own new output.
Regeneration cascades to the end of the graph.

**Rewiring alone never changes an existing output.** It changes what the *next* run produces. To pin
an older context as the live branch, drag an edge from that output node into a step and re-run.

### Wiring rules

| Edge | Meaning |
| --- | --- |
| output → input | context: that artifact's text is fed to the step |
| input → output | provenance: marks which artifact is that step's current one |
| input → input | pre-wiring: resolves into `output → input` once the upstream step first runs |
| input ↔ tool | attaches a capability to a step; either direction attaches it |
| tool → output | provenance, created by a run when a tool sits in the chain |
| output → output | rejected — carries no context |

Edges are drawn with arrowheads because **direction decides run order**. To edit one: drag either
endpoint onto another handle to move it, drop it on empty canvas to delete it, or double-click the
edge to reverse it. Selecting an edge and pressing Backspace also deletes it.

Pre-wiring lets you build a whole pipeline before running anything; the graph materialises its
output nodes on the first pass.

## Controls

Run order comes from the edges. Dependencies follow directed paths and walk through whatever sits
in between, so `step -> tool -> step` orders those steps exactly as `step -> step` does. Steps with
no ordering between them run in the order they were created; canvas position never affects the
schedule, so dragging a node about cannot resequence a run. Each step shows its place in the queue
on its header.

- **Run** — topological pass over every step. Cycles are detected and reported instead of hanging.
- **Next** — executes only the next ready step, so you can watch context accumulate hop by hop.
- **Reset** — moves the step cursor back to the start without discarding any outputs.
- **Clear outputs** — removes every artifact, leaving the steps and their wiring.
- **Export / Import** — round-trips the graph as JSON. The canvas also autosaves to `localStorage`.

## Trace

Every step execution is written to a DuckDB database at `data/mnemonic.duckdb`, independently of
the canvas. Clearing outputs, deleting nodes or starting a fresh graph leaves the history intact.

**Trace** in the toolbar opens a panel beside the canvas: an accordion of runs, steps within each
run, and per step the full record —

- when it ran, how long it took, the model asked for and the dated snapshot actually served
- thinking level, and token usage
- the system prompt exactly as sent, the resolved upstream context, and the composed input prompt
- every tool offered, and every tool call with its arguments
- the output, any reasoning summaries the model returned, and the raw request/response for each
  round of the tool loop

Each run has a **Delete run** button. Failed steps are recorded too, with their error, so a run that
went wrong is inspectable rather than lost.

```
runs        one row per Run / Next / single-step invocation
step_runs   one row per step execution, with the full payloads as JSON
```

The graph itself still autosaves to `localStorage`; only the run history lives in DuckDB.

## Layout

```
server/index.ts   Express proxy: /api/models, /api/run, /api/mcp/tools, /api/trace/*
server/trace.ts   DuckDB schema, writes and queries for the run history
src/graph.ts      the engine — topological order, context resolution, run commits
src/types.ts      node and edge shapes
src/App.tsx       canvas, toolbar, run loop
src/nodes/        node views
src/TracePanel.tsx  the trace accordion
```
