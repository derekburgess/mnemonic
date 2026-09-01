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

The key can also be set in the app: the wrench in the toolbar opens **Settings**, which writes to
`data/settings.json` (mode 600, gitignored). A key set there takes precedence over `.env`, and the
browser is only ever told *whether* a key is set, never what it is.

| Script | What it does |
| --- | --- |
| `npm run dev` | proxy + UI together, both watching |
| `npm run dev:server` | just the proxy (`tsx watch`, also watches `.env`) |
| `npm run dev:web` | just the Vite dev server |
| `npm run build` | typecheck and build the UI to `dist/` |
| `npm run typecheck` | types only, no emit |

Two things are created on first use and are gitignored: `.env`, and `data/mnemonic.duckdb` for the
run history.

## Providers

Settings picks which API surface the proxy speaks:

| Provider | Endpoint | Use for |
| --- | --- | --- |
| **OpenAI** | `/v1/responses` | OpenAI itself |
| **OpenAI-compatible** | `/v1/chat/completions` | OpenRouter, vLLM, Ollama, LM Studio, Together |

Both are kept because neither is a superset. Function calling is universal, so **MCP tools, custom
tools, fan-out, ordering and the trace all work identically on either**. What is specific to the
Responses API is the built-in **web search** tool and the model's **reasoning items** - ask for web
search on a compatible provider and the run stops with a message saying so, rather than silently
dropping the tool.

Set the base URL alongside the provider, for example `https://openrouter.ai/api/v1`. The model
dropdown lists whatever that endpoint offers; OpenAI's catalogue is curated, another provider's is
listed as-is.

## The model

There are two kinds of node: **steps** and **artifacts**.

**Input nodes** are the steps. Each holds a model, a thinking level (`reasoning_effort`), an
**Output N** fan-out count, a **Role**, **Instructions**, and its own input text.

The model dropdown is populated from a live `/v1/models` call through the proxy, so it never goes
stale. The API has no notion of a deprecated model, so the proxy filters what it can: other
modalities (audio, image, realtime…) and purpose-built variants (codex, deep-research, search) are
dropped, dated snapshots are collapsed into their alias, and what is left is ordered newest first.

`Output N` generates N candidates from the same prompt in parallel, as N sibling artifacts. The
step wires to all of them, and so does anything downstream - a following step receives every
candidate as context, not just one. Delete or unwire the ones you do not want. If some generations fail the step still commits the ones
that succeeded and reports how many did not.

**Output nodes** are immutable artifacts. Every run produces a *new* output node — outputs are never
overwritten, they accumulate on the canvas as a visible history.

### Skip

Both node kinds have a **Skip** toggle. Skipping keeps the node on the canvas with its wiring
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

## Tools

Tools belong to a step, listed under its Input field — add as many as you like, each collapsible.
Skipping the step withholds all of them. They are **capabilities, not context**: they carry no text, produce no
artifacts, and take no part in scheduling, so they never appear on the canvas or affect the run
order. Whatever the model actually invoked is recorded on the artifact the step produced.

They were once nodes wired into a step. Folding them into the step removed a node kind, three edge
rules and the chain-rewiring they required, for no loss of capability. Graphs saved with tool nodes
are migrated on load: each tool is adopted by the steps it was wired to, and its edges dropped.

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

### Rounds and timeouts

Each round is one request to the model, so a step that made five tool calls records six rounds in
the trace - five calls plus the final answer. Two step parameters bound how far that can go:

- **Rounds** (default 12) - how many times the model may come back asking for more tools.
- **Timeout** (default 5m) - a budget for the whole step: every round plus the tools they call.
  Enforced on the server as well as in the browser, so an abandoned run stops costing tokens.

Each MCP and custom tool has its own **Timeout** too, since how long a tool needs is a property of
the tool rather than of the step calling it. MCP defaults to 5 minutes (the SDK's own default is
60s, short for tools that do real work), reset whenever the server reports progress, with a ceiling
of three times the budget. Custom code defaults to 5 seconds.

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
| output → output | rejected — carries no context |

Edges are drawn with arrowheads because **direction decides run order**. To edit one: drag either
endpoint onto another handle to move it, drop it on empty canvas to delete it, or double-click the
edge to reverse it. Selecting an edge and pressing Backspace also deletes it.

Pre-wiring lets you build a whole pipeline before running anything; the graph materialises its
output nodes on the first pass.

## Controls

Run order comes from the edges: a step depends on another when an artifact of that step feeds it,
or when a pre-wired `step -> step` edge does. Steps with
no ordering between them run in the order they were created; canvas position never affects the
schedule, so dragging a node about cannot resequence a run. Each step shows its place in the queue
on its header, and the step that would run next is ringed in green. To step through by hand, use a
step's own Run button.

- **Run** — topological pass over every step. Cycles are detected and reported instead of hanging.
- **Reset** — clears the run state and puts the cursor back at the first step, without discarding
  any outputs. It is never disabled, so it also cancels a run that is taking too long.
- **Clear outputs** — removes every artifact, leaving the steps and their wiring.
- **Export / Import** — round-trips the graph as JSON. The canvas also autosaves to `localStorage`.

## Trace

Every step execution is written to a DuckDB database at `data/mnemonic.duckdb`, independently of
the canvas. Clearing outputs, deleting nodes or starting a fresh graph leaves the history intact.

**Trace Logs** in the toolbar opens a panel beside the canvas: an accordion of runs, steps within each
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
src/nodes/        node views and the inline tool editor
src/TracePanel.tsx  the trace accordion
```
