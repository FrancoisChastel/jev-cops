import { afterEach, describe, expect, test } from "bun:test";
import { KillLatch } from "./kill-latch.ts";

const ROOT = "sess_root";
const SUB = "sess_root.agent_1";

let latch: KillLatch | null = null;
afterEach(() => {
  latch?.close();
  latch = null;
});

function open(now = () => 1_000): KillLatch {
  latch = new KillLatch(":memory:", now);
  return latch;
}

describe("KillLatch", () => {
  test("nothing is latched at first", () => {
    const l = open();
    expect(l.find(ROOT, ROOT)).toBeNull();
    expect(l.count()).toBe(0);
  });

  test("a subagent's kill latches it and its root; the root covers every subagent", () => {
    const l = open();
    l.latch(SUB, ROOT, "kill", "evt_1");
    expect(l.find(SUB, ROOT)).toMatchObject({ rootId: ROOT, cause: "kill", eventId: "evt_1" });
    expect(l.find(ROOT, ROOT)).not.toBeNull();
    expect(l.find("sess_root.agent_2", ROOT)).not.toBeNull();
    expect(l.find("sess_other", "sess_other")).toBeNull();
    expect(l.count()).toBe(1);
  });

  test("a second latch keeps the first cause and time", () => {
    let at = 1_000;
    const l = open(() => at);
    l.latch(ROOT, ROOT, "config-change", "evt_1");
    at = 2_000;
    l.latch(ROOT, ROOT, "kill", "evt_2");
    expect(l.find(ROOT, ROOT)).toEqual({
      sessionId: ROOT,
      rootId: ROOT,
      at: 1_000,
      cause: "config-change",
      eventId: "evt_1",
    });
  });

  test("unlatch clears the root and its subagents, and only them", () => {
    const l = open();
    l.latch(SUB, ROOT, "kill", "evt_1");
    l.latch("sess_other", "sess_other", "kill", "evt_2");
    expect(l.count()).toBe(2);
    expect(l.unlatch(ROOT)).toBe(2);
    expect(l.find(SUB, ROOT)).toBeNull();
    expect(l.find("sess_other", "sess_other")).not.toBeNull();
    expect(l.unlatch(ROOT)).toBe(0);
  });

  test("close is idempotent", () => {
    const l = open();
    l.close();
    l.close();
    latch = null;
  });
});
