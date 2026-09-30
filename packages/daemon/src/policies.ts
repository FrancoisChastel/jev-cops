import { type FSWatcher, watch } from "node:fs";
import { loadPolicies, type PolicyDefinition } from "@jev-cops/core";

/** The policy set in force; replaced whole on a successful reload, never mutated. */
export interface PolicySnapshot {
  readonly policies: readonly PolicyDefinition[];
  /** 1 at boot, +1 per applied reload. */
  readonly generation: number;
  readonly loadedAt: number;
}

/** Thrown at boot when the directory cannot be loaded cleanly. */
export class PolicyLoadError extends Error {
  override readonly name = "PolicyLoadError";
  constructor(readonly problems: readonly string[]) {
    super(`policy load failed: ${problems.join("; ")}`);
  }
}

/** Callbacks and timing for {@link PolicySet}. */
export interface PolicySetOptions {
  onReload?: (snapshot: PolicySnapshot) => void;
  /** A reload was refused; the previous set stays in force. */
  onRejected?: (problems: string[]) => void;
  /** Coalesces bursts of file events (editors write several times). Default 100 ms. */
  debounceMs?: number;
  now?: () => number;
}

/** Outcome of one reload attempt. */
export interface ReloadResult {
  readonly applied: boolean;
  readonly problems: readonly string[];
}

const DEFAULT_DEBOUNCE_MS = 100;

/**
 * The daemon's policies: loaded from `[policies] dir` with core `loadPolicies`, watched
 * with `fs.watch`, reloaded with Bun's import cache busted per changed file. Invariant:
 * the set in force always loaded without problems. At boot any problem is fatal; on
 * reload a problem, or a result with zero policies, keeps the previous set and is
 * reported, so a typo never leaves the daemon judging with nothing.
 */
export class PolicySet {
  private snapshot: PolicySnapshot;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly dir: string,
    policies: readonly PolicyDefinition[],
    private opts: PolicySetOptions,
  ) {
    this.snapshot = { policies, generation: 1, loadedAt: this.now() };
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Loads `dir`; throws {@link PolicyLoadError} on any loader problem. */
  static async load(dir: string, opts: PolicySetOptions = {}): Promise<PolicySet> {
    const loaded = await loadPolicies(dir, { cacheBust: true });
    if (loaded.problems.length > 0) throw new PolicyLoadError(loaded.problems);
    return new PolicySet(dir, Object.freeze([...loaded.policies]), opts);
  }

  /** Replaces the callbacks (the daemon opens its audit log after a clean boot load). */
  setCallbacks(opts: PolicySetOptions): void {
    this.opts = { ...opts };
  }

  /** The set in force. */
  current(): PolicySnapshot {
    return this.snapshot;
  }

  private async reloadNow(): Promise<ReloadResult> {
    const loaded = await loadPolicies(this.dir, { cacheBust: true });
    const problems =
      loaded.problems.length > 0
        ? loaded.problems
        : loaded.policies.length === 0
          ? [`reload of ${this.dir} found no policies; keeping the previous set`]
          : [];
    if (problems.length > 0) {
      this.opts.onRejected?.(problems);
      return { applied: false, problems };
    }
    this.snapshot = {
      policies: Object.freeze([...loaded.policies]),
      generation: this.snapshot.generation + 1,
      loadedAt: this.now(),
    };
    this.opts.onReload?.(this.snapshot);
    return { applied: true, problems: [] };
  }

  /** Reloads now; reloads are serialized so two never race. */
  reload(): Promise<ReloadResult> {
    const next = this.chain.then(() => this.reloadNow());
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Starts watching the directory; each burst of changes triggers one reload. */
  watch(): void {
    if (this.watcher !== null) return;
    const debounce = this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.watcher = watch(this.dir, () => {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.reload().catch((cause: unknown) => {
          this.opts.onRejected?.([`reload failed: ${String(cause)}`]);
        });
      }, debounce);
    });
  }

  /** Stops watching. Idempotent. */
  close(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
