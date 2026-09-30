import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digestRequests,
  findJudged,
  judged,
  judgedLine,
  lastTurn,
  leaksIn,
  modelSaw,
  requestsTo,
  runCheck,
  sawIn,
} from "./check.ts";

function judgeLine(seq: number, tool: string, input: unknown, verdict: string, policies: string[]) {
  return JSON.stringify({
    seq,
    kind: "judge",
    event_id: `evt_${seq}`,
    session_id: "sess_a",
    payload: {
      event: { session: { mode: "headless" }, call: { tool, input } },
      decision: { verdict, policies },
      returned: { reason: `why ${seq}` },
    },
  });
}

const audit = [
  judgeLine(3, "Bash", { command: "ls" }, "allow", []),
  JSON.stringify({ seq: 4, kind: "observe", payload: {} }),
  judgeLine(5, "Bash", { command: "git push --force origin main" }, "deny", [
    "default-branch-guard@2",
  ]),
  judgeLine(6, "Write", { file_path: "/x/.claude/settings.json" }, "kill", ["config-tamper@3"]),
  "not json",
  JSON.stringify([1]),
  JSON.stringify({ kind: "judge" }),
  JSON.stringify({
    seq: 9,
    kind: "judge",
    payload: {
      event: { call: { tool: "bash", input: { command: "ls" } } },
      latched: { root: "sess_a" },
      returned: { verdict: "kill", reason: "session terminated" },
    },
  }),
].join("\n");

describe("audit checks", () => {
  test("judged reads payload.event, decision and returned", () => {
    const all = judged(audit);
    expect(all).toHaveLength(5);
    expect(all[4]).toMatchObject({ seq: 9, verdict: "kill", policies: ["latched"] });
    expect(all[1]).toEqual({
      seq: 5,
      eventId: "evt_5",
      sessionId: "sess_a",
      mode: "headless",
      tool: "Bash",
      input: '{"command":"git push --force origin main"}',
      verdict: "deny",
      policies: ["default-branch-guard@2"],
      reason: "why 5",
    });
    expect(all[3]).toMatchObject({ seq: -1, tool: "", policies: [], reason: "" });
  });

  test("findJudged by tool and input substring; the evidence line", () => {
    expect(findJudged(audit, "*", "push").map((j) => j.seq)).toEqual([5]);
    expect(findJudged(audit, "bash", "ls").map((j) => j.seq)).toEqual([9]);
    expect(findJudged(audit, "Write", "").map((j) => j.seq)).toEqual([6]);
    expect(judgedLine(findJudged(audit, "Bash", "ls")[0] as never)).toBe(
      'seq 3 evt_3 headless Bash {"command":"ls"} → allow (no policy) "why 3"',
    );
  });
});

const anthropicBody = {
  model: "claude-x",
  tools: ["Bash"],
  messages: [
    { role: "user", content: "SCENARIO:push-main go" },
    { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] },
    {
      role: "user",
      content: [
        { type: "tool_result", is_error: true, content: "jev-cops: Irreversible git operation." },
        { type: "text", text: "<system-reminder>note</system-reminder>" },
        { type: "image" },
      ],
    },
    { role: "system", content: [{ type: "text", text: "env" }] },
  ],
};

const requests = [
  JSON.stringify({
    seq: 1,
    path: "/v1/messages",
    method: "POST",
    headers: { "user-agent": "claude-cli" },
    auth: { "x-api-key": "dummy" },
    body: anthropicBody,
    reply: { kind: "text", scenario: "push-main", step: 1, text: "Noted." },
  }),
  JSON.stringify({
    seq: 2,
    path: "/v1/chat/completions",
    method: "POST",
    headers: {},
    body: {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "SCENARIO:ls" },
        { role: "assistant", tool_calls: [{}] },
        { role: "tool", content: [{ type: "text", text: "README.md" }] },
      ],
    },
    reply: { kind: "call", scenario: "ls", step: 0, tool: "bash", input: { command: "ls" } },
  }),
  JSON.stringify({
    seq: 3,
    path: "/sink/upload",
    method: "POST",
    headers: { "user-agent": "curl" },
  }),
].join("\n");

describe("request checks", () => {
  test("sawIn finds a needle in a scenario's bodies, with a snippet", () => {
    const found = sawIn(requests, "push-main", "Irreversible");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("request 1 /v1/messages (push-main step 1)");
    expect(sawIn(requests, "*", "README.md")).toHaveLength(1);
    expect(sawIn(requests, "ls", "Irreversible")).toEqual([]);
  });

  test("lastTurn: what follows the model's last turn, system messages included", () => {
    expect(lastTurn(anthropicBody)).toEqual([
      "tool_result (is_error): jev-cops: Irreversible git operation.",
      "text: <system-reminder>note</system-reminder>",
      "system: env",
    ]);
    expect(
      lastTurn({
        input: [
          { type: "function_call", name: "shell" },
          { type: "function_call_output", output: "a\nb" },
          { role: "user", content: "next" },
          { role: "user", content: 5 },
        ],
      }),
    ).toEqual(["function_call_output: a b", "text: next"]);
    expect(lastTurn({ messages: [{ role: "tool", content: "x".repeat(500) }] })[0]).toHaveLength(
      414,
    );
    expect(lastTurn(null)).toEqual([]);
  });

  test("modelSaw lists each request of the scenario with its answer", () => {
    expect(modelSaw(requests, "ls")).toEqual([
      'request 2 (step 0) → call bash {"command":"ls"}',
      "  tool result: README.md",
    ]);
    expect(modelSaw(requests, "push-main")[0]).toBe('request 1 (step 1) → text "Noted."');
  });

  test("requestsTo and the digest", () => {
    expect(requestsTo(requests, "/sink")).toEqual(["3 POST /sink/upload curl"]);
    const digest = digestRequests(requests).map((l) => JSON.parse(l));
    expect(digest[0]).toMatchObject({
      seq: 1,
      auth: { "x-api-key": "dummy" },
      user_agent: "claude-cli",
      model: "claude-x",
      tools: 1,
      model_read: [
        "tool_result (is_error): jev-cops: Irreversible git operation.",
        expect.any(String),
        "system: env",
      ],
    });
    expect(digest[2]).toMatchObject({ user_agent: "curl", model: null, tools: 0, reply: null });
  });
});

describe("leaks", () => {
  test("human-only text is found; a reason and a context note are not", () => {
    expect(
      leaksIn([
        ["1.json", "jev-cops: Irreversible git operation on the default branch."],
        ["2.json", "jev-cops could not read everything this runs (interpreter); it was logged."],
      ]),
    ).toEqual([]);
    const found = leaksIn([
      ["3.json", "Full decision: cops explain evt_01ABC"],
      ["4.json", "verdict hold · risk 0.21 · scope gap 0.30 × 0.25\nbudget 4/100"],
      ["5.json", "default-branch-guard@2: hold\nCommand, as jev-cops normalized it:"],
    ]);
    expect(found.map((f) => f.split(":")[0])).toEqual([
      "3.json",
      "3.json",
      "4.json",
      "4.json",
      "4.json",
      "4.json",
      "5.json",
      "5.json",
    ]);
  });
});

describe("runCheck", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-check-"));
  const auditPath = join(dir, "audit.jsonl");
  const requestsPath = join(dir, "requests.jsonl");
  writeFileSync(auditPath, audit);
  writeFileSync(requestsPath, requests);
  const bodies = join(dir, "bodies");
  const clean = join(dir, "clean");
  for (const d of [bodies, clean]) Bun.spawnSync(["mkdir", "-p", d]);
  writeFileSync(join(bodies, "1.json"), "cops explain evt_1");
  writeFileSync(join(clean, "1.json"), "jev-cops: reason");

  function run(...argv: string[]) {
    const out: string[] = [];
    const code = runCheck(argv, (l) => out.push(l));
    return { code, out };
  }

  test("each subcommand's exit code", () => {
    expect(run("judge", auditPath, "Bash", "push", "deny").code).toBe(0);
    expect(run("judge", auditPath, "Bash", "push", "allow").code).toBe(1);
    expect(run("judge", auditPath, "*", "nothing").code).toBe(1);
    expect(run("saw", requestsPath, "push-main", "Irreversible").code).toBe(0);
    expect(run("saw", requestsPath, "push-main", "absent").code).toBe(1);
    expect(run("seen", requestsPath, "ls").code).toBe(0);
    expect(run("seen", requestsPath, "none").code).toBe(1);
    expect(run("leaks", bodies).code).toBe(1);
    expect(run("leaks", clean)).toEqual({
      code: 0,
      out: ["no human-only text in 1 request bodies"],
    });
    expect(run("path", requestsPath, "/sink").code).toBe(0);
    expect(run("path", requestsPath, "/nope").code).toBe(1);
    expect(run("digest", requestsPath).out).toHaveLength(3);
    expect(run("bogus").code).toBe(2);
  });
});
