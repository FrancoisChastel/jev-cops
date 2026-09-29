import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALLED_FILE, installPiExtension, PI_GAPS } from "./install.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "jvinst-"));
  dirs.push(d);
  return d;
}
const SOURCE = readFileSync(join(import.meta.dir, "jevdict.ts"), "utf8");

describe("installPiExtension", () => {
  test("project install copies the extension into <project>/.pi/extensions", () => {
    const project = temp();
    const out: string[] = [];
    const r = installPiExtension({ projectDir: project, print: (l) => out.push(l) });
    expect(r.path).toBe(join(project, ".pi", "extensions", INSTALLED_FILE));
    expect(readFileSync(r.path, "utf8")).toBe(SOURCE);
    expect(r.socket).toBeNull();
    expect(out.join("\n")).toContain(r.path);
  });

  test("global install goes to $PI_CODING_AGENT_DIR/extensions, else ~/.pi/agent/extensions", () => {
    const agent = temp();
    const home = temp();
    const quiet = { print: () => undefined };
    expect(
      installPiExtension({ global: true, env: { PI_CODING_AGENT_DIR: agent }, ...quiet }).path,
    ).toBe(join(agent, "extensions", INSTALLED_FILE));
    expect(installPiExtension({ global: true, env: {}, home, ...quiet }).path).toBe(
      join(home, ".pi", "agent", "extensions", INSTALLED_FILE),
    );
  });

  test("a socket is baked into the installed file as a string literal", () => {
    const project = temp();
    const socket = '/var/run/jevdict/d "q".sock';
    const r = installPiExtension({ projectDir: project, socket, print: () => undefined });
    const text = readFileSync(r.path, "utf8");
    expect(text).toContain(`const INSTALLED_SOCKET: string | null = ${JSON.stringify(socket)};`);
    expect(text).not.toContain("const INSTALLED_SOCKET: string | null = null;");
    expect(r.socket).toBe(socket);
    expect(statSync(r.path).mode & 0o777).toBe(0o644);
  });

  test("the installed copy loads and uses the baked socket over $JEVDICT_SOCKET", async () => {
    const socket = "/run/j$&v/$1.sock";
    const r = installPiExtension({ projectDir: temp(), socket, print: () => undefined });
    const mod = (await import(r.path)) as { socketPath(env: Record<string, string>): string };
    expect(mod.socketPath({ JEVDICT_SOCKET: "/elsewhere.sock" })).toBe(socket);
  });

  test.each([
    ["relative", "d.sock"],
    ["too long for sun_path", `/${"x".repeat(120)}.sock`],
    ["with a newline", "/tmp/a\nb.sock"],
  ])("refuses a socket path that is %s", (_why, socket) => {
    expect(() =>
      installPiExtension({ projectDir: temp(), socket, print: () => undefined }),
    ).toThrow(/socket/);
  });

  test("reinstalling overwrites a stale or edited copy", () => {
    const project = temp();
    const first = installPiExtension({ projectDir: project, print: () => undefined });
    writeFileSync(first.path, "export default function () {}\n");
    installPiExtension({ projectDir: project, print: () => undefined });
    expect(readFileSync(first.path, "utf8")).toBe(SOURCE);
  });

  test("prints every known gap", () => {
    const out: string[] = [];
    const r = installPiExtension({ projectDir: temp(), print: (l) => out.push(l) });
    expect(r.gaps).toEqual(PI_GAPS);
    for (const gap of PI_GAPS) expect(out.join("\n")).toContain(gap);
    expect(PI_GAPS.length).toBeGreaterThanOrEqual(5);
  });
});
