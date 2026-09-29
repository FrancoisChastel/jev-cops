import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContextConfigInput,
  type Event,
  type Judge,
  mergeConfig,
  mintEventId,
  type PolicyConfigInput,
} from "@jevdict/core";
import { registerSdkModule } from "@jevdict/sdk/register";
import { type AuditLine, readAudit } from "../audit.ts";
import type { DaemonConfig, EnforcementMode, HttpBind } from "../config.ts";
import { SILENT_LOGGER } from "../log.ts";
import { type RunningDaemon, startDaemon } from "../server.ts";

/** What a test daemon is built from; everything has a test-friendly default. */
export interface TestDaemonOptions {
  /** File name → module source, written into the policies directory. */
  policies: Readonly<Record<string, string>>;
  /**
   * Copy the policies of this directory (e.g. the repo's `policies/`) instead; `policies`
   * is then ignored. The copy lives in the test daemon's own directory, with
   * `@jevdict/sdk` registered as the binary does, so a test daemon never watches or
   * re-imports the source directory.
   */
  policiesDir?: string;
  judge?: Judge;
  mode?: EnforcementMode;
  deadlineMs?: number;
  judgeTimeoutMs?: number;
  holdTokenTtlMs?: number;
  http?: HttpBind | null;
  context?: ContextConfigInput;
  policy?: PolicyConfigInput;
  now?: () => number;
}

/** A daemon on a temp Unix socket plus helpers to call it and read its audit log. */
export interface TestDaemon {
  readonly daemon: RunningDaemon;
  readonly dir: string;
  readonly config: DaemonConfig;
  /** A request on the agent socket (what an adapter, or an agent, can reach). */
  call(method: Method, path: string, body?: unknown): Promise<HttpReply>;
  /** A request on the admin socket (human-only routes). */
  callAdmin(method: Method, path: string, body?: unknown): Promise<HttpReply>;
  audit(): AuditLine[];
  writePolicy(file: string, source: string): void;
  stop(): Promise<void>;
}

type Method = "GET" | "POST";
type HttpReply = { status: number; body: unknown };

/** One JSON request over the Unix socket at `socket`; a string body is sent verbatim. */
async function request(socket: string, method: Method, path: string, body?: unknown) {
  const res = await fetch(`http://localhost${path}`, {
    method,
    unix: socket,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
}

/** A fresh event id, so tests never collide on `explain` or `resolve`. */
export function withFreshId<E extends Event>(e: E): E {
  return { ...e, id: mintEventId() };
}

/** The config a test daemon runs with; `when` budget relaxed so cold JIT never flakes. */
export function testConfig(dir: string, opts: TestDaemonOptions): DaemonConfig {
  return {
    daemon: {
      socket: join(dir, "d.sock"),
      adminSocket: join(dir, "a.sock"),
      http: opts.http ?? null,
      home: "/home/dev",
      judgeDeadlineMs: opts.deadlineMs ?? 12_000,
      holdTokenTtlMs: opts.holdTokenTtlMs ?? 600_000,
    },
    policies: { dir: join(dir, "policies") },
    judge: {
      provider: "off",
      model: null,
      timeoutMs: opts.judgeTimeoutMs ?? 10_000,
      cacheTtlMs: 600_000,
    },
    context: opts.context ?? {},
    policy: mergeConfig<PolicyConfigInput>({ when: { budgetMs: 1_000 } }, opts.policy ?? {}),
    audit: { path: join(dir, "audit.jsonl"), forward: null },
    store: { path: join(dir, "store.sqlite") },
    enforcement: { mode: opts.mode ?? "enforce" },
  };
}

/** Starts a daemon in a new temp directory (short path: Unix sockets cap at ~104 bytes). */
export async function startTestDaemon(opts: TestDaemonOptions): Promise<TestDaemon> {
  const dir = mkdtempSync(join(tmpdir(), "jvd-"));
  mkdirSync(join(dir, "policies"));
  if (opts.policiesDir === undefined) {
    for (const [file, source] of Object.entries(opts.policies)) {
      writeFileSync(join(dir, "policies", file), source);
    }
  } else {
    registerSdkModule();
    const skip = /\.test\.[cm]?[jt]s$/;
    cpSync(opts.policiesDir, join(dir, "policies"), {
      recursive: true,
      filter: (src) => !skip.test(src),
    });
  }
  const config = testConfig(dir, opts);
  const daemon = await startDaemon(config, {
    log: SILENT_LOGGER,
    ...(opts.judge === undefined ? {} : { judge: opts.judge }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  return {
    daemon,
    dir,
    config,
    call: (method, path, body) => request(config.daemon.socket, method, path, body),
    callAdmin: (method, path, body) => request(config.daemon.adminSocket, method, path, body),
    audit: () => readAudit(config.audit.path).lines,
    writePolicy(file, source) {
      writeFileSync(join(dir, "policies", file), source);
    },
    async stop() {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
