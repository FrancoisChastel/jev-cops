import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvent } from "../../../../tests/fixtures/context/index.ts";
import { startTestDaemon, withFreshId } from "../../../daemon/src/testing/daemon.ts";
import { policyModule } from "../../../daemon/src/testing/policies.ts";
import { captureIo } from "../io.ts";
import { runReplayCommand } from "./replay.ts";

const guard = (verdict: string) =>
  policyModule("guard", 1, verdict).replace(
    "when: () => true",
    'when: (e) => e.kind === "fs.delete"',
  );
const ASKS = policyModule(
  "asks",
  1,
  "allow",
  `ask: () => [{ kind: "noul", name: "fine", text: "Is this fine?" }],
  decide: (_e, _c, a) => (a.fine.p > 0.5 ? "annotate" : "hold"),`,
).replace('decide: () => "allow", ', "");

let root: string;
let audit: string;
let deleteId: string;
let answered: number;

function policiesDir(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir);
  for (const [f, src] of Object.entries(files)) writeFileSync(join(dir, f), src);
  return dir;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jevdict-replay-"));
  const { createMockJudge } = await import("@jevdict/core");
  const td = await startTestDaemon({
    policies: { "guard.ts": guard("hold"), "asks.ts": ASKS },
    judge: createMockJudge({ "asks/fine": { kind: "noul", p: 0.9, confidence: 1 } }),
    policy: { ask: { min: 0 } },
  });
  const bash = (command: string) =>
    withFreshId(buildEvent({ tool: "Bash", kind: "exec", input: { command } }, { task: "t" }));
  const del = bash("rm -rf /srv/data");
  const ls = bash("ls");
  await td.call("POST", "/v1/judge", ls);
  const post = withFreshId(
    buildEvent(
      { tool: "Bash", kind: "exec", input: { command: "ls" } },
      { task: "t", callId: ls.call.id },
      { stdout: "a b c" },
    ),
  );
  await td.call("POST", "/v1/observe", post);
  await td.call("POST", "/v1/judge", del);
  await td.call("POST", "/v1/judge", bash("cat README.md"));
  answered = td.audit().filter((l) => l.kind === "judge" && l.payload.answers !== null).length;
  await td.daemon.stop();
  audit = join(root, "audit.jsonl");
  await Bun.write(audit, Bun.file(td.config.audit.path));
  rmSync(td.dir, { recursive: true, force: true });
  deleteId = del.id;
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("jevdict replay", () => {
  test("unchanged policies: zero deltas, recorded judge answers replayed", async () => {
    const dir = policiesDir("same", { "guard.ts": guard("hold"), "asks.ts": ASKS });
    const io = captureIo();
    expect(await runReplayCommand([audit, "--policies", dir], io)).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("3 judged event(s)");
    expect(text).toMatch(/^0 deltas$/m);
    expect(text).not.toContain("→");
    expect(answered).toBeGreaterThan(0);
  });

  test("without the recorded answers the asking policy would differ (the answers matter)", async () => {
    const stripped = join(root, "stripped.jsonl");
    const text = await Bun.file(audit).text();
    const lines = text
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> })
      .map((l) =>
        l.kind === "judge"
          ? {
              ...l,
              payload: {
                ...l.payload,
                answers: null,
                decision: { ...(l.payload.decision as object), jev: [] },
              },
            }
          : l,
      );
    writeFileSync(stripped, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const dir = policiesDir("stripped", { "guard.ts": guard("hold"), "asks.ts": ASKS });
    const io = captureIo();
    await runReplayCommand([stripped, "--policies", dir], io);
    expect(io.stdout.join("\n")).not.toMatch(/^0 deltas$/m);
  });

  test("one policy verdict edited: exactly one delta, printed as old → new", async () => {
    const dir = policiesDir("edited", { "guard.ts": guard("deny"), "asks.ts": ASKS });
    const io = captureIo();
    expect(await runReplayCommand([audit, "--policies", dir], io)).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain(`${deleteId}  hold → deny`);
    expect(text).toMatch(/^1 delta$/m);
  });

  test("history that cannot be rebuilt is said per event", async () => {
    const dir = policiesDir("notes", { "guard.ts": guard("hold"), "asks.ts": ASKS });
    const io = captureIo();
    await runReplayCommand([audit, "--policies", dir, "--json"], io);
    const report = JSON.parse(io.stdout.join("\n")) as { events: { notes: string[] }[] };
    const notes = report.events.flatMap((e) => e.notes).join("\n");
    expect(notes).toContain("not in the audit log");
    expect(notes).toContain("no post line");
  });

  test("a tampered log is replayed with a chain warning", async () => {
    const copy = join(root, "tampered.jsonl");
    const text = await Bun.file(audit).text();
    writeFileSync(copy, text.replace('"verdict":"hold"', '"verdict":"allow"'));
    const dir = policiesDir("tamper", { "guard.ts": guard("hold"), "asks.ts": ASKS });
    const io = captureIo();
    expect(await runReplayCommand([copy, "--policies", dir], io)).toBe(0);
    expect(io.stderr.join("\n")).toContain("audit chain broken");
  });

  test("usage and unreadable inputs", async () => {
    expect(await runReplayCommand([], captureIo())).toBe(2);
    expect(await runReplayCommand([join(root, "none.jsonl")], captureIo())).toBe(1);
  });
});
