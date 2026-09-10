import { fetchGraph, pushGraph } from "./api";
import type { GraphNode, GraphEdge } from "./types";
export type Snapshot = { nodes: GraphNode[]; edges: GraphEdge[] };
export const GRAPH_KEY = "mnemonic.graph.v1";
const META_KEY = "mnemonic.graph.sync.v1";
export type SaveState = { label: "Checking" | "Saved" | "Saving" | "Cached locally" | "Conflict" | "Not saved"; error?: string; ready: boolean };

/** One writer per canvas; changes made during an in-flight save remain dirty. */
export class GraphSync {
  private revision: number | null = null;
  private dirty = false;
  private ready = false;
  private stopped = false;
  private writing = false;
  private conflict = false;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private cached = true;
  private snapshot: Snapshot;
  private publish: (snapshot: Snapshot) => void;
  private state: (state: SaveState) => void;
  constructor(snapshot: Snapshot, publish: (snapshot: Snapshot) => void, state: (state: SaveState) => void) {
    this.snapshot = snapshot; this.publish = publish; this.state = state;
    try {
      const meta = JSON.parse(localStorage.getItem(META_KEY) ?? "null");
      this.revision = meta?.revision ?? null;
      this.dirty = meta?.dirty ?? !!localStorage.getItem(GRAPH_KEY);
    } catch { this.dirty = true; }
  }
  private status(label: SaveState["label"], error?: string) {
    if (!this.stopped) this.state({ label: !this.cached && label === "Cached locally" ? "Not saved" : label, error, ready: this.ready });
  }
  private cache() {
    try {
      localStorage.setItem(GRAPH_KEY, JSON.stringify(this.snapshot));
      localStorage.setItem(META_KEY, JSON.stringify({ revision: this.revision, dirty: this.dirty }));
      this.cached = true;
    } catch { this.cached = false; }
  }
  update(snapshot: Snapshot) {
    if (JSON.stringify(snapshot) === JSON.stringify(this.snapshot)) return;
    this.snapshot = snapshot; this.generation++; this.dirty = true; this.cache();
    if (!this.conflict) this.schedule(500);
  }
  async start() {
    const generation = this.generation;
    this.status("Checking");
    try {
      const remote = await fetchGraph();
      if (this.stopped) return;
      const same = remote && JSON.stringify({ nodes: remote.nodes, edges: remote.edges }) === JSON.stringify(this.snapshot);
      if (remote && this.dirty && !same && this.revision !== remote.updatedMs) {
        this.ready = true; this.conflict = true; this.cache();
        this.status("Conflict", "Local edits and the saved graph differ. Choose which version to keep."); return;
      }
      if (remote && !this.dirty && generation === this.generation) {
        this.snapshot = { nodes: remote.nodes as GraphNode[], edges: remote.edges as GraphEdge[] };
        this.publish(this.snapshot);
      }
      this.revision = remote?.updatedMs ?? null;
      if (same) this.dirty = false;
      if (!remote) this.dirty = true;
      this.ready = true; this.cache();
      if (this.dirty) this.schedule(0); else this.status("Saved");
    } catch (err) {
      if (this.stopped) return;
      this.cache(); this.status("Cached locally", (err as Error).message);
      this.timer = setTimeout(() => void this.start(), 3000);
    }
  }
  private schedule(ms: number) {
    if (this.stopped || this.conflict || !this.ready) return;
    clearTimeout(this.timer); this.status("Saving");
    this.timer = setTimeout(() => void this.flush(), ms);
  }
  private async flush() {
    if (this.writing || this.stopped || this.conflict) return;
    this.writing = true;
    const generation = this.generation;
    const snapshot = this.snapshot;
    try {
      this.revision = await pushGraph(snapshot.nodes, snapshot.edges, this.revision);
      if (this.stopped) return;
      this.dirty = generation !== this.generation; this.cache();
      if (this.dirty) this.schedule(0); else this.status("Saved");
    } catch (err) {
      if (this.stopped) return;
      this.cache();
      if ((err as { status?: number }).status === 409) { this.conflict = true; this.status("Conflict", (err as Error).message); }
      else { this.status("Cached locally", (err as Error).message); this.timer = setTimeout(() => void this.flush(), 3000); }
    } finally { this.writing = false; }
  }
  async resolve(keep: "local" | "remote") {
    try {
      const remote = await fetchGraph();
      if (this.stopped) return;
      if (keep === "remote") {
        // Keep a recoverable copy of the local branch before replacing it.
        localStorage.setItem(`${GRAPH_KEY}.conflict-backup`, JSON.stringify(this.snapshot));
        this.snapshot = remote ? { nodes: remote.nodes as GraphNode[], edges: remote.edges as GraphEdge[] } : { nodes: [], edges: [] };
        this.publish(this.snapshot); this.dirty = false;
      } else this.dirty = true;
      this.revision = remote?.updatedMs ?? null; this.conflict = false; this.ready = true; this.cache();
      if (this.dirty) this.schedule(0); else this.status("Saved");
    } catch (err) { this.status("Conflict", (err as Error).message); }
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}
