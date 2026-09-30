import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookPort } from "@jev-cops/adapter-claude-code/process";
import type { Server } from "bun";
import { claudeCodePayloadText } from "../../../../tests/fixtures/claude-code/index.ts";
import { captureIo } from "../io.ts";
import { runHookCommand } from "./hook.ts";

const dirs: string[] = [];
const servers: Server<undefined>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "jvcli-hook-"));
  dirs.push(dir);
  return dir;
}

function port(stdin: string) {
  const rec = { out: "", err: "", exits: [] as number[] };
  const p: HookPort = {
    env: {},
    home: temp(),
    ppid: process.pid,
    managedDir: null,
    readStdin: async () => stdin,
    write: (fd, text) => {
      if (fd === 1) rec.out += text;
      else rec.err += text;
    },
    exit: (code) => {
      rec.exits.push(code);
    },
    onFatal: () => undefined,
    setExitCode: () => undefined,
  };
  return { p, rec };
}

describe("cops hook", () => {
  test("--harness claude-code judges the stdin payload through the daemon", async () => {
    const socket = join(temp(), "d.sock");
    servers.push(
      Bun.serve({
        unix: socket,
        fetch: async (req) => {
          const e = (await req.json()) as { id: string };
          return Response.json({ event_id: e.id, verdict: "deny", reason: "no" });
        },
      }),
    );
    const { p, rec } = port(claudeCodePayloadText("pre-tool-use.bash"));
    const argv = ["--harness", "claude-code", "--socket", socket];
    expect(await runHookCommand(argv, captureIo(), p)).toBe(2);
    expect(rec.err).toBe("jev-cops: no\n");
    expect(rec.exits).toEqual([2]);
  });

  test("pi is not a hook harness: exit 2", async () => {
    const { p, rec } = port("{}");
    expect(await runHookCommand(["--harness", "pi"], captureIo(), p)).toBe(2);
    expect(rec.err).toContain("pi is not a hook harness");
  });
});
