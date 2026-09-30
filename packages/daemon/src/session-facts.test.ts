import { afterEach, describe, expect, test } from "bun:test";
import { parseSessionEvent, type SessionEvent } from "@jev-cops/core";
import { noHumanOf, SessionFactsStore } from "./session-facts.ts";
import { sessionReport } from "./testing/session.ts";

let store: SessionFactsStore | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

function parsed(r: unknown): SessionEvent {
  const p = parseSessionEvent(r);
  if (!p.ok) throw new Error(p.error.message);
  return p.value;
}

describe("noHumanOf", () => {
  test.each([
    ["headless", undefined, "headless"],
    ["headless", "default", "headless"],
    ["headless", "auto", "headless"], // Claude Code 2.1.286's -p default
    ["interactive", "dontAsk", "permission-mode"],
    [undefined, "bypassPermissions", "permission-mode"],
    [null, "someFutureMode", "permission-mode"],
    ["interactive", "default", null],
    ["interactive", "auto", null],
    [undefined, "acceptEdits", null],
    [undefined, undefined, null],
    [null, null, null],
  ] as const)("mode %p + permission %p → %p", (mode, permission, expected) => {
    expect(noHumanOf(mode, permission)).toBe(expected);
  });
});

describe("SessionFactsStore", () => {
  test("unknown sessions have no facts", () => {
    store = new SessionFactsStore(":memory:");
    expect(store.get("sess_x")).toBeNull();
  });

  test("start facts are kept; later reports update what they carry", () => {
    store = new SessionFactsStore(":memory:");
    const start = sessionReport("start", { model: "m1", harness_version: "2.1.285" });
    store.record("sess_x", parsed(start));
    const prompt = sessionReport("prompt", { prompt: "p" }, { permissionMode: "plan" });
    const facts = store.record("sess_x", parsed(prompt));
    expect(facts).toEqual({
      harness: "claude-code",
      harnessVersion: "2.1.285",
      model: "m1",
      mode: "interactive",
      permissionMode: "plan",
      noHuman: null,
    });
    expect(store.get("sess_x")).toEqual(facts);
  });

  test("no human is sticky: a later report cannot switch holds back to asks", () => {
    store = new SessionFactsStore(":memory:");
    const bypass = sessionReport("start", {}, { permissionMode: "bypassPermissions" });
    expect(store.record("sess_x", parsed(bypass)).noHuman).toBe("permission-mode");
    const back = sessionReport("prompt", { prompt: "p" }, { permissionMode: "default" });
    const facts = store.record("sess_x", parsed(back));
    expect(facts).toMatchObject({ permissionMode: "default", noHuman: "permission-mode" });
  });

  test("a headless start is remembered for events that carry no mode", () => {
    store = new SessionFactsStore(":memory:");
    const start = sessionReport("start", {}, { mode: "headless" });
    expect(store.record("sess_x", parsed(start))).toMatchObject({
      mode: "headless",
      noHuman: "headless",
    });
  });
});
