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

Local files are gitignored: `.env`, `data/graph.duckdb` for the canvas, and `data/mnemonic.duckdb` for the
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

### Attachments and links

A step can carry four kinds of material besides its prompt:

- **Add workspace** - a folder on this machine the step lends the model, reachable through the
  workspace tools. See below.
- **Attach skill files (.md)** - inlined into the *system prompt* after the instructions, as
  standing guidance.
- **Attach files (.pdf, .txt, .png, .jpg)** - sent with the *input*. PDFs and images go natively
  (OpenAI extracts a PDF's text and renders its pages), anything else is decoded and inlined.
- **Add links** - URLs fetched at run time. Pages are converted to readable text; linked images and
  PDFs are downloaded and sent as content. A link that cannot be fetched is reported to the model
  in place rather than failing the step.

Links are fetched by the proxy rather than handed to the model as URLs, so private hosts work and
hosts that refuse unfamiliar clients do not break. File payloads are elided from the trace, which
keeps the request shape without writing the same megabytes once per round.

### Workspaces

**Add workspace** hands a step a folder rather than a copy of a file. Clicking it makes a row and
opens **your desktop's own folder chooser** - GTK, KDE, Finder or Explorer, whichever this machine
has. Dismissing it leaves the row in place, so a path can just be typed instead, and the folder icon
on any row reopens the chooser. Rows are removed like any other attachment.

The chooser is opened by the *proxy*, not the browser, and that is the point: **no browser API can
tell a page where a folder is.** `showDirectoryPicker()` returns a handle, `webkitdirectory` a set
of relative paths - neither is a location. Worse, `webkitdirectory` is the *upload* path: Firefox
labels its button "Upload"
([bug 1295914](https://bugzilla.mozilla.org/show_bug.cgi?id=1295914)) and Chromium interrupts with
*"are you sure you want to upload all files from…"*, because that API really does hand the page
every file in the folder. Entirely the wrong shape for choosing somewhere to work.

Since the proxy runs on the same machine as the browser, it just asks the desktop directly -
`zenity`, `qarma` or `kdialog` on Linux, `osascript` on macOS, `FolderBrowserDialog` on Windows -
and reads the path straight off the result. **Nothing is enumerated, nothing is uploaded, no browser
prompts, and every browser behaves identically**, since none of them are involved.

The path field is still editable, completes as you type, and carries a mark - filled when it is
really a folder on this machine, hollow when it is not.

#### Running the proxy on another machine

`workspace_read` and `workspace_write` execute **in the proxy**, so a workspace is a folder on the
*proxy's* filesystem. When the proxy is on the machine you are sitting at - the normal case - that
is also your desktop, and the chooser opens where you can see it.

If it is not, the chooser is the wrong tool:

| Proxy runs | What happens |
| --- | --- |
| Same machine | chooser opens on your desktop; the path is the folder you picked |
| Headless box or container | no `DISPLAY`, so `/api/fs/pick` answers `501` and the browser's picker takes over |
| Another machine **with** a display | the window opens *there* - on a screen you may not be looking at |

That last row cannot be detected from either end. Vite forwards `/api` server-side, so the proxy
always sees a loopback client however far away the browser is; and a forwarded port makes the page
`localhost` to the browser. So it is a switch: set `MNEMONIC_FOLDER_DIALOG=off` and the proxy stops
offering to open windows.

With the chooser off or unavailable, the row falls back to the browser's own picker, which only
learns the folder's name and the entries inside it. Those go to `/api/fs/resolve`, which searches
for the one folder matching both - **on the proxy's filesystem, which is the one that matters**. A
folder picked on your laptop usually will not be found on a remote dev box, and the row says so.
Typing the path is the reliable route there, and completion queries the proxy, so it is completing
against the right machine.

A step with at least one workspace is offered three tools, derived rather than configured, so they
never appear under Tools:

| Tool | Does |
| --- | --- |
| `workspace_list` | list a folder; called with no path, lists the workspaces themselves |
| `workspace_read` | read a text file |
| `workspace_write` | write a text file, creating folders as needed |

There is no `cd`. Every path is resolved against a named root, so there is no working directory to
move and no per-step state to keep in step with a model that may call these in any order. Roots are
addressed by name - `notes/x.md`, not `/home/you/private/notes/x.md` - which keeps the shape of your
home directory out of the prompt; two workspaces ending in the same folder name get a `-2` suffix.
A preamble listing the roots is appended to the system prompt, and shows up in the trace.

**Paths are jailed to the roots.** `..`, an absolute path elsewhere, and `~` are all refused, and
containment is checked twice: once on the path as written, and again on the nearest existing
ancestor resolved through its symlinks - the second is the one that catches a link inside the
workspace pointing at `/etc`. Reads stop at 256 KB and refuse anything that looks binary.

> Within a root, `workspace_write` overwrites without asking. And `/api/fs/pick` puts a window on
> your desktop on request, on the same open local port as the rest of the proxy - only one at a
> time, and it times out after five minutes. Same posture as the custom tools below: a local tool
> for your own machine, not something to expose.

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
| Workspace | This proxy | Derived from the step's workspaces, not added here |

With **Run in container** on, everything in that table except web search runs inside the container
instead of in the proxy.

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

### Running a step in a container

Above **Add workspace** each step has a **Run in container** switch. With it on, that execution of
the step happens inside an ephemeral container: created when the step starts, destroyed when it
returns. Nothing is reused between runs.

`--rm` alone would not be enough for that, which is worth spelling out because it is the obvious
thing to assume. It removes a container when the container *exits* — and killing the `docker run`
client does not stop the container, it carries on quite happily detached. So teardown removes the
container **by name**, from every path: normal return, step timeout, and proxy shutdown
(`SIGINT`/`SIGTERM`). For the one case no handler can cover — `SIGKILL`, or the machine losing
power — every container is labelled, and the proxy sweeps anything a previous life of itself left
behind on startup. `tsx watch` restarts on every save, so that path gets exercised often.
Stopped containers are inspected before removal to retain exit and OOM evidence. A deadline
first kills the container, then inspection and cleanup run.

The whole step goes in - the model call, the tool loop, the workspace access - so what stays
outside is only what should never be ephemeral: the graph, the trace database, the HTTP surface.
The job crosses on stdin and the result on stdout, so the container needs no port and no volume
beyond the step's own workspaces.

**Why bother.** `node:vm` is not a security boundary, and it is easy to show. A custom tool
running the textbook escape gets the proxy's own process:

| | uncontained | contained |
| --- | --- | --- |
| `this.constructor.constructor("return process")()` | escapes | escapes |
| working directory it lands in | this repo | `/app` in the container |
| **`OPENAI_API_KEY` readable from `process.env`** | **yes** | **no** |

The escape is not what the container prevents - it prevents that escape from being worth
anything. The key is passed to the runner on **stdin rather than in the environment**, so it is
absent from `docker inspect` and from `/proc/self/environ` inside the container. It is still in
the runner's memory, so this is isolation from *the host*, not a promise that a determined tool
can never reach it.

**Workspaces become mounts.** Each is bind-mounted at `/workspaces/<name>`, under the same name the
tools use uncontained, so a prompt reads identically either way and the host's directory shape stays
out of it. The path jail stops being a `realpath` check and becomes the mount boundary.

**Network stays on**, because a step that cannot reach the model is not a step. So a contained tool
still has egress.

An MCP server on your own machine keeps working, but not by rewriting its URL. Pointing the client
at `host.docker.internal` reaches the server and is then refused: FastMCP and friends check the
`Host` header against an allow-list and answer **421 Misdirected Request** to a name they do not
know. Setting the header manually is not available either - `fetch` silently drops `Host`. So the
URL is left exactly as written and the *port* is brought into the container instead, forwarded from
the container's own loopback to the host. The client connects to `127.0.0.1:8765` for real, sends
`Host: 127.0.0.1:8765`, and the server sees what it expects.

The container is `node:22-bookworm-slim`, running as its non-root `node` user, with `--cap-drop=ALL`,
`--security-opt=no-new-privileges`, and 2 GB / 2 CPUs / 512 pids. The image is tagged by a hash of
everything baked into it, so editing a provider or a tool rebuilds rather than silently running
yesterday's code. The first contained run builds it, which takes about 15 seconds; after that a
contained step costs a second or two more than an uncontained one.

> **A step that asks to be contained and cannot be fails.** If Docker is missing or its daemon is
> unreachable, the step errors with the reason rather than quietly running on the host - silently
> dropping an isolation guarantee is worse than not offering one. The switch also disables itself,
> with the reason, when the proxy reports it cannot contain anything.

With `Output N` above 1 the fan-out issues N runs in parallel, so that is N containers at once.

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

### Asynchronous execution and recovery

`POST /api/run` persists admission and returns **202** with `{runId, execId}` before model execution
finishes. Repeating the request with the same IDs returns the existing execution rather than
running its tools again. `GET /api/executions/:runId/:execId` reports `pending`, `ok`, or `error`.
The browser polls with short HTTP deadlines; the step's Timeout still bounds model/tool execution.
`POST /api/executions/:runId/:execId/cancel` requests cancellation, including container termination.

Pending execution IDs are cached before submission. Refreshing the page reconciles pending
fan-out groups and recovers completed outputs once. Outputs carry their execution IDs to prevent
duplicates. This recovers outputs; it does not automatically resume downstream steps after a page
reload or replay interrupted tools after a proxy restart. Use Next or Run when ready to continue.
Completed traces also have **Add saved output to graph**, provided the original source step still
exists. Recovered outputs append to current connections and do not replace newer outputs.

### Canvas storage

The graph uses `data/graph.duckdb`; trace schema failures do not block its reads or writes.
On first startup, the existing graph is copied from `data/mnemonic.duckdb`, leaving the legacy
copy in place. Each database has a versioned schema and creates restricted-permission backups
in `data/backups/` before migrations. Do not delete either database as a troubleshooting step.

The canvas reports **Saved**, **Saving**, or **Cached locally**, and retries failed saves.
Writes include the revision they were based on. When local edits conflict with a newer saved
graph, choose **Keep local edits** or **Load saved graph**; neither branch silently replaces the
other. Loading the saved version retains a local conflict backup. If localStorage itself is
unavailable or full, the status says **Not saved** instead of claiming an offline cache exists.

### Reading traces

Every step execution is written to a DuckDB database at `data/mnemonic.duckdb`, independently of
the canvas. Clearing outputs, deleting nodes or starting a fresh graph leaves the history intact.

**Trace Logs** in the toolbar opens a panel beside the canvas: an accordion of runs, steps within each
run, and per step the full record —

- when it ran, how long it took, the model asked for and the dated snapshot actually served
- thinking level, token usage, and the step's own limits (max rounds, timeout)
- every file attached, with its type and size
- every link, and what it resolved to - fetched text, media, or the error that stopped it
- the system prompt, resolved upstream context, and composed input, subject to redaction and
  payload limits (long payloads are marked as truncated)
- every tool offered, and every tool call with its arguments
- for contained steps, **Container diagnostics**: timestamped lifecycle events, image and container
  names, exit code/signal, and the last 65,536 characters of stderr (including tool console output).
  These are saved on success and failure, including startup/build failures. Docker's stopped
  state, OOM flag, termination reason and cgroup peak memory (when available) are recorded too.
- the output, any reasoning summaries the model returned, and the raw request/response for each
  round of the tool loop

Each run has a **Delete run** button. Failed steps are recorded too, with their error, so a run that
went wrong is inspectable rather than lost.

The overview leads with execution outcome, delivery outcome, duration and the last meaningful
event. **Timeline** groups HTTP attempts by model round, tool activity by call ID, and polling
under result delivery. Individual events and raw payloads remain expandable. Open traces
poll incremental events every two seconds; the run list refreshes every five seconds. Execution
state is separate from delivery state: a completed execution can still be awaiting delivery,
recovering, received, or added to the graph. “Added to graph” acknowledges the browser's canvas
update; it does not certify a later graph autosave. Correlation details include `runId`, `execId`,
node ID, the execution budget and the longer setup/delivery deadline. Times come from the source;
hover over an event to see the proxy receipt time if machine clocks differ.

Model events record rounds, HTTP attempts/retries, status and request ID. Tool events record
call IDs, rounds, arguments/results, durations, errors and timeouts; MCP transport attempts are
linked to the tool call. Tool execution is not automatically retried. **Tool timings** provides
a compact comparison, while event payloads remain expandable.

Events are written independently of the final result. On proxy restart, unfinished executions
become **interrupted**, preserving their last recorded progress. Browser telemetry uses bounded,
idempotent batches with up to three delivery attempts; a browser that closes or stays offline can
still lose its unacknowledged events. Server-side events continue even if the run response drops.

Known API/MCP credentials and sensitive object fields are redacted before persistence. Event
payloads are capped at 16,384 characters, with at most 2,500 events per execution and reserved
space for completion acknowledgements. Live stderr samples are bounded to 65,536 characters;
the final container diagnostics retain the stderr tail separately. Old traces have no timeline.
Peak memory can be unavailable after an abrupt exit or on hosts without the relevant cgroup files.

```
runs        one row per Run / Next / single-step invocation
step_runs   one row per step execution, with the full payloads as JSON
trace_events independently persisted lifecycle, model, tool and delivery events
```

The graph also autosaves to DuckDB, with a localStorage cache.

## Verification

```bash
npm test                       # unit, migration/restart and local HTTP integration tests
npx playwright install chromium # first browser-test setup
npm run test:browser            # refresh, cancellation, fan-out, recovery and save conflicts
npm run test:docker             # optional: requires a running Docker daemon
npm run build
```

The browser suite uses a local Vite server and mocked API responses. Set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing Chromium installation. The opt-in Docker suite
uses a real ephemeral container, temporary workspace and a local mock model: it tests networking,
workspace writes, stderr capture, exit inspection and cancellation without paid model calls.
The ordinary test command skips that suite. Migration tests use temporary databases and abrupt
process termination to exercise WAL replay and preserve existing graph/event data.

## Layout

```
server/index.ts   Express proxy: /api/models, /api/run, /api/mcp/tools, /api/fs/*, /api/trace/*
server/trace.ts   DuckDB schema, writes and queries for the run history
server/workspace.ts  the desktop folder chooser, and the jailed list/read/write tools
server/sandbox.ts    building the image and running one step in a container
server/runner.ts     the entrypoint inside the container: job on stdin, result on stdout
sandbox/Dockerfile   the image that step runs in
src/graph.ts      the engine — topological order, context resolution, run commits
src/types.ts      node and edge shapes
src/App.tsx       canvas, toolbar, run loop
src/nodes/        node views and the inline tool editor
src/TracePanel.tsx  the trace accordion
```

### Managed Hugging Face models

Local inference requires Docker. The first run builds a dedicated Transformers image, with
Python and model dependencies installed inside it; no host Python environment is required.
The runtime image is rebuilt automatically when its Dockerfile, dependencies or worker change.
Inference uses CPU by default. Enable **Use GPU** on a downloaded model’s card in Settings for
NVIDIA inference. This replaces automatic detection and `MNEMONIC_MODEL_DEVICE` overrides.
Downloads always use CPU containers. GPU inference requires NVIDIA Container Toolkit configured for Docker. Apple Metal is not available inside this Linux runtime.
Select **Hugging Face** in Settings and enable **Download and run models locally**.
Add a Hugging Face repository ID to the **Local models** list in Settings and click **Download**.
Wait for **Downloaded**, then select or type that ID in the node; no OpenAI key is needed.
Downloads run in the background independently of node timeouts, can be cancelled/retried, and
continue when Settings closes. **Delete** removes a model cache when the runtime is idle.
Save a Hugging Face token for gated/private repositories after accepting their access terms.

Local inference uses a separate, ephemeral model container. While local model mode is enabled, the existing **Run in a container** option is automatically
enabled and locked on all input nodes. The server also enforces this requirement. Disable local
model mode first to unlock the switches; their on state is preserved until you change it.
Containerized nodes connect to the worker through the proxy.
Sandbox containers must be able to reach the proxy through `host.docker.internal`.
The node sandbox contains execution/tools; the model container contains Python and model inference.
Runs are serialized to avoid loading multiple models at once. Each model container is forcibly removed and cleanup is confirmed after success, error, timeout or cancellation before the next model is admitted.
Downloads remain in `data/models`; weights are not retained in memory between nodes.
Nodes load completed downloads from the shared cache without accessing the Hub. Model files are
bind-mounted read-only into inference containers, not copied per run. Inference containers have
network access disabled; only download containers contact Hugging Face. Node timeouts cover queueing, loading and
inference; model downloads are separate settings jobs with no node timeout.
Existing caches appear as **Incomplete** until Download verifies them and writes a completion marker.

The header shows lifecycle status and download bytes/progress. Node errors include memory,
download and loading failures, with detailed lifecycle events under the trace's `local` filter.
Docker-confirmed OOM kills are reported in the node; unexplained exits retain their uncertain cause.
Containers are labeled per workspace and cleaned up after crashes/restarts. Cache files and images persist.

This initial runtime supports text-generation Transformers models with safetensors weights and
chat templates, using CPU or CUDA when available. Tool-enabled nodes additionally require
a tokenizer response template that Transformers can parse. Unsupported architectures, custom
remote-code models, non-text attachments and missing templates fail explicitly. Model IDs are
not restricted to a curated list. Generation is currently capped at 1,024 new tokens per round.

Optional real-model smoke test (downloads a small public model):
`MNEMONIC_TEST_TRANSFORMERS=1 node --import tsx --test tests/local-model-real.test.ts`.
