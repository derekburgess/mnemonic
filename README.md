# mnemonic

A graph-based UI for building agent orchestrations as **context graphs**. You lay out steps on an
open canvas, wire them together, and run the graph — either all at once or one hop at a time.

## Quick start

```bash
npm install
cp .env.example .env      # add your OPENAI_API_KEY
npm run dev               # proxy on :8787, UI on :5173
```

The API key lives only in the local proxy under `server/`. It is never bundled into the browser.

## The model

There are two kinds of node.

**Input nodes** are the steps. Each holds a model, a thinking level (`reasoning_effort`), an
**Output N** fan-out count, a **Role**, **Instructions**, and its own input text. The model dropdown is populated from a live
`/v1/models` call through the proxy, so it does not go stale.

`Output N` generates N candidates from the same prompt in parallel, as N sibling artifacts. The
producer wires to all of them; any downstream chain follows the first. Rewire to whichever candidate
you prefer and re-run to continue from it. If some generations fail the step still commits the ones
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

Pre-wiring lets you build a whole pipeline before running anything; the graph materialises its
output nodes on the first pass.

## Controls

- **Run** — topological pass over every step. Cycles are detected and reported instead of hanging.
- **Next** — executes only the next ready step, so you can watch context accumulate hop by hop.
- **Reset** — moves the step cursor back to the start without discarding any outputs.
- **Clear outputs** — removes every artifact, leaving the steps and their wiring.
- **Export / Import** — round-trips the graph as JSON. The canvas also autosaves to `localStorage`.

## Layout

```
server/index.ts   Express proxy: GET /api/models, POST /api/run
src/graph.ts      the engine — topological order, context resolution, run commits
src/types.ts      node and edge shapes
src/App.tsx       canvas, toolbar, run loop
src/nodes/        node views
```
