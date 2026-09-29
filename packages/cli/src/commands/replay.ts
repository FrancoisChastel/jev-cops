import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadPolicies } from "@jevdict/core";
import { readAudit, verifyChain } from "@jevdict/daemon";
import { EXIT, type Io } from "../io.ts";
import { type ReplayReport, replayAudit } from "../replay-engine.ts";

const f2 = (n: number) => n.toFixed(2);

/** Calls the kill latch answered: one line each, their extra notes, and their count. */
function renderLatched(report: ReplayReport): string[] {
  if (report.latched.length === 0) return [];
  const lines = report.latched.flatMap((l) => [
    `${l.eventId}  kill (latched since ${l.latchedBy}, cause ${l.cause}; not a policy decision)`,
    ...l.notes.slice(1).map((note) => `${l.eventId}  note: ${note}`),
  ]);
  const count = `${report.latched.length} latched call(s) replayed as kill (the latch is state, not a policy decision; never a delta)`;
  return [...lines, count];
}

/**
 * Human rendering: one line per delta, notes per event, the calls the kill latch answered
 * (apart), problems, the delta count.
 */
export function renderReplay(report: ReplayReport, header: string): string[] {
  const lines = [`${header}: ${report.events.length} judged event(s)`];
  for (const e of report.events) {
    if (e.old !== e.next) {
      lines.push(`${e.eventId}  ${e.old} → ${e.next}  (risk ${f2(e.oldRisk)} → ${f2(e.newRisk)})`);
    }
    for (const note of e.notes) lines.push(`${e.eventId}  note: ${note}`);
  }
  lines.push(...renderLatched(report));
  for (const p of report.problems) lines.push(`PROBLEM ${p}`);
  lines.push(`${report.deltas} ${report.deltas === 1 ? "delta" : "deltas"}`);
  return lines;
}

/**
 * `jevdict replay <audit.jsonl> [--policies dir] [--json]`: re-judges the recorded pre
 * events with the current policies and prints `event_id old → new` per delta. Exit 0 with
 * the delta count (a delta is information, not a failure); 1 when the log or the
 * policies cannot be read; 2 on usage errors. A broken hash chain is reported first.
 */
export async function runReplayCommand(argv: readonly string[], io: Io): Promise<number> {
  let parsed: { values: { policies?: string; json?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { policies: { type: "string" }, json: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (cause) {
    io.err(`jevdict replay: ${(cause as Error).message}`);
    return EXIT.usage;
  }
  const [path, ...extra] = parsed.positionals;
  if (path === undefined || extra.length > 0) {
    io.err("jevdict replay: expected exactly one audit log path");
    return EXIT.usage;
  }
  const { lines, problems } = readAudit(path);
  if (lines.length === 0) {
    io.err(`jevdict replay: no audit lines in ${path}`);
    return EXIT.failed;
  }
  const chain = verifyChain(path);
  if (!chain.ok)
    io.err(
      `WARNING audit chain broken at seq ${chain.brokenAt} (${chain.reason}); replaying anyway`,
    );
  for (const p of problems) io.err(`WARNING ${p}`);
  const dir = resolve(parsed.values.policies ?? "policies");
  const loaded = await loadPolicies(dir);
  if (loaded.problems.length > 0) {
    for (const p of loaded.problems) io.err(`jevdict replay: ${p}`);
    return EXIT.failed;
  }
  const report = await replayAudit(lines, loaded.policies);
  if (parsed.values.json === true) io.out(JSON.stringify(report, null, 2));
  else {
    const header = `replay of ${path} against ${dir} (${loaded.policies.length} policies)`;
    for (const line of renderReplay(report, header)) io.out(line);
  }
  return EXIT.ok;
}
