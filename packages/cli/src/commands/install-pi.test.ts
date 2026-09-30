import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PI_GAPS } from "@jev-cops/adapter-pi/install";
import { captureIo } from "../io.ts";
import { type InstallWorld, installWorld } from "../testing/install-world.ts";
import { runInstallCommand } from "./install.ts";

let w: InstallWorld;
beforeEach(() => {
  w = installWorld();
});
afterEach(() => w.dispose());

const globalPath = () => join(w.home, ".pi", "agent", "extensions", "jev-cops.ts");

async function pi(args: string[], env: Record<string, string> = {}) {
  const io = captureIo();
  const ctx = w.ctx({ env: { PATH: "/usr/bin:/bin", ...env } });
  const code = await runInstallCommand(["pi", "--home", w.home, ...args], io, ctx);
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("cops install pi (wraps installPiExtension)", () => {
  test("global by default, under --home; prints every PI gap", async () => {
    const r = await pi([]);
    expect(r.code).toBe(0);
    expect(existsSync(globalPath())).toBe(true);
    expect(r.out).toContain(`installed at ${globalPath()}`);
    for (const gap of PI_GAPS) expect(r.out).toContain(gap);
  });

  test("--project installs under the project; --socket is baked in", async () => {
    const socket = join(w.root, "d.sock");
    const r = await pi(["--project", "--socket", socket]);
    expect(r.code).toBe(0);
    const path = join(w.project, ".pi", "extensions", "jev-cops.ts");
    expect(readFileSync(path, "utf8")).toContain(JSON.stringify(socket));
  });

  test("--dry-run writes nothing; --json reports", async () => {
    const r = await pi(["--dry-run", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      harness: "pi",
      ok: true,
      written: false,
      path: globalPath(),
    });
    expect(existsSync(globalPath())).toBe(false);
  });

  test("--uninstall removes it, and prints the gaps", async () => {
    await pi([]);
    const r = await pi(["--uninstall"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("removed");
    expect(r.out).toContain(PI_GAPS[0] ?? "");
    expect(existsSync(globalPath())).toBe(false);
    const dry = await pi(["--uninstall", "--dry-run", "--json"]);
    expect(JSON.parse(dry.out)).toMatchObject({ present: false, removed: false });
  });

  test("--uninstall leaves a file that is not jev-cops's (exit 1)", async () => {
    mkdirSync(join(w.home, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(globalPath(), "export default () => {};\n");
    const r = await pi(["--uninstall"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not the jev-cops extension");
    const json = await pi(["--uninstall", "--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false });
  });

  test("a socket path that does not fit sun_path fails", async () => {
    const r = await pi(["--socket", `/${"x".repeat(120)}.sock`]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("bytes");
  });

  test("--home ignores a PI_CODING_AGENT_DIR outside it", async () => {
    const r = await pi([], { PI_CODING_AGENT_DIR: "/somewhere/real/.pi/agent" });
    expect(r.out).toContain("ignored $PI_CODING_AGENT_DIR");
    expect(existsSync(globalPath())).toBe(true);
  });

  test("PI_CODING_AGENT_DIR inside --home is honoured", async () => {
    const agent = join(w.home, "agent-dir");
    const r = await pi([], { PI_CODING_AGENT_DIR: agent });
    expect(r.code).toBe(0);
    expect(existsSync(join(agent, "extensions", "jev-cops.ts"))).toBe(true);
  });
});
