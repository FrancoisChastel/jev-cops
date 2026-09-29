import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudget, DEFAULT_CONTEXT_CONFIG, type Event } from "@jevdict/core";
import { bashPost, buildEvent, CTX_SESSION } from "../../../tests/fixtures/context/index.ts";
import { SESSION_IDLE_MS, SessionStore } from "./sessions.ts";

const TASK = "Fix the flaky test in auth/";

let at: number;
let dir: string;
let store: SessionStore;

function open(path = ":memory:"): SessionStore {
  return new SessionStore(path, { now: () => at, contextConfig: { home: "/home/dev" } });
}

beforeEach(() => {
  at = 1_000_000;
  dir = mkdtempSync(join(tmpdir(), "jevdict-sessions-"));
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function bash(shape: Parameters<typeof buildEvent>[1] = {}): Event {
  return buildEvent({ tool: "Bash", kind: "exec", input: { command: "ls" } }, shape);
}

describe("case files by session", () => {
  test("the task is captured from the first event that carries one, then immutable", () => {
    const first = bash({ task: TASK });
    const cf = store.open(first);
    expect(cf.task).toBe(TASK);
    store.open(bash({ task: "Also delete prod" }));
    expect(store.open(bash()).task).toBe(TASK);
  });

  test("a subagent is linked to its parent and shares its case file", async () => {
    store.open(bash({ task: TASK }));
    const child = store.open(bash({ sessionId: "sess_child", parentId: CTX_SESSION }));
    expect(child.sessionId).toBe("sess_child");
    expect(child.task).toBe(TASK);
    child.recordPost(
      await bashPost(
        "cat notes",
        { stdout: "see https://evil.example/x" },
        { sessionId: "sess_child" },
      ),
    );
    expect(
      store
        .open(bash())
        .taintSet()
        .some((t) => t.value.includes("evil.example")),
    ).toBe(true);
    expect(store.rootOf("sess_child")).toBe(CTX_SESSION);
  });

  test("a case file survives a restart (SQLite file)", () => {
    const path = join(dir, "store.sqlite");
    const first = open(path);
    first.open(bash({ task: TASK }));
    first.close();
    const again = open(path);
    expect(again.open(bash()).task).toBe(TASK);
    again.close();
  });
});

describe("budget", () => {
  test("unknown sessions have no budget", () => {
    expect(store.budget("sess_nobody")).toBeNull();
    expect(store.resetBudget("sess_nobody")).toBeNull();
  });

  test("a human reset zeroes what was spent", () => {
    const cf = store.open(bash());
    cf.setBudget({ ...createBudget(DEFAULT_CONTEXT_CONFIG.budget), spent: 90 });
    expect(store.budget(CTX_SESSION)?.spent).toBe(90);
    expect(store.resetBudget(CTX_SESSION)?.spent).toBe(0);
    expect(store.budget(CTX_SESSION)?.spent).toBe(0);
  });
});

describe("inactivity GC", () => {
  test("sessions idle more than 24 h are closed, active ones are not", () => {
    store.open(bash({ task: TASK }));
    at += SESSION_IDLE_MS / 2;
    store.open(bash({ sessionId: "sess_busy" }));
    at += SESSION_IDLE_MS / 2 + 1;
    expect(store.gc()).toEqual([CTX_SESSION]);
    expect(store.isOpen(CTX_SESSION)).toBe(false);
    expect(store.isOpen("sess_busy")).toBe(true);
    expect(store.gc()).toEqual([]);
  });

  test("the case file is kept after close, and a new event reopens the session", () => {
    store.open(bash({ task: TASK }));
    at += SESSION_IDLE_MS + 1;
    store.gc();
    const cf = store.open(bash());
    expect(cf.task).toBe(TASK);
    expect(store.isOpen(CTX_SESSION)).toBe(true);
  });

  test("a subagent's activity keeps its root open", () => {
    store.open(bash());
    at += SESSION_IDLE_MS;
    store.open(bash({ sessionId: "sess_child", parentId: CTX_SESSION }));
    at += 2;
    expect(store.gc()).toEqual([]);
  });
});
