import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extensionCandidates,
  extensionSource,
  INSTALLED_FILE,
  installPiExtension,
  PI_GAPS,
  piExtensionPath,
  uninstallPiExtension,
} from "./install.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "jvinst-"));
  dirs.push(d);
  return d;
}
const SOURCE = readFileSync(join(import.meta.dir, "jev-cops.ts"), "utf8");

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
    const socket = '/var/run/jev-cops/d "q".sock';
    const r = installPiExtension({ projectDir: project, socket, print: () => undefined });
    const text = readFileSync(r.path, "utf8");
    expect(text).toContain(`const INSTALLED_SOCKET: string | null = ${JSON.stringify(socket)};`);
    expect(text).not.toContain("const INSTALLED_SOCKET: string | null = null;");
    expect(r.socket).toBe(socket);
    expect(statSync(r.path).mode & 0o777).toBe(0o644);
  });

  test("the installed copy loads and uses the baked socket over $JEV_COPS_SOCKET", async () => {
    const socket = "/run/j$&v/$1.sock";
    const r = installPiExtension({ projectDir: temp(), socket, print: () => undefined });
    const mod = (await import(r.path)) as { socketPath(env: Record<string, string>): string };
    expect(mod.socketPath({ JEV_COPS_SOCKET: "/elsewhere.sock" })).toBe(socket);
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

describe("dry run and uninstall (cops install pi)", () => {
  const quiet = { print: () => undefined };

  test("piExtensionPath names the file an install would write", () => {
    const project = temp();
    expect(piExtensionPath({ projectDir: project })).toBe(
      join(project, ".pi", "extensions", INSTALLED_FILE),
    );
  });

  test("dry run prints the target and writes nothing", () => {
    const project = temp();
    const out: string[] = [];
    const r = installPiExtension({ projectDir: project, dryRun: true, print: (l) => out.push(l) });
    expect(r.written).toBe(false);
    expect(existsSync(r.path)).toBe(false);
    expect(out.join("\n")).toContain("dry run");
    expect(out.join("\n")).toContain(PI_GAPS[0] ?? "");
  });

  test("uninstall removes the installed extension only", () => {
    const project = temp();
    const r = installPiExtension({ projectDir: project, ...quiet });
    expect(r.written).toBe(true);
    const dry = uninstallPiExtension({ projectDir: project, dryRun: true, ...quiet });
    expect(dry).toEqual({ path: r.path, removed: false, present: true });
    expect(existsSync(r.path)).toBe(true);
    expect(uninstallPiExtension({ projectDir: project, ...quiet })).toEqual({
      path: r.path,
      removed: true,
      present: true,
    });
    expect(existsSync(r.path)).toBe(false);
    expect(uninstallPiExtension({ projectDir: project, ...quiet }).present).toBe(false);
  });

  test("uninstall refuses a file that is not the jev-cops extension", () => {
    const project = temp();
    const path = piExtensionPath({ projectDir: project });
    installPiExtension({ projectDir: project, ...quiet });
    writeFileSync(path, "export default function () {}\n");
    expect(() => uninstallPiExtension({ projectDir: project, ...quiet })).toThrow(
      "not the jev-cops",
    );
    expect(existsSync(path)).toBe(true);
  });
});

describe("extensionSource: where the extension text comes from", () => {
  test("next to the installer, then the repository of a compiled cops", () => {
    const [here, repo] = extensionCandidates("/checkout/dist/cops");
    expect(here).toBe(join(import.meta.dir, "jev-cops.ts"));
    expect(repo).toBe("/checkout/adapters/pi/jev-cops.ts");
    expect(extensionSource(null, ["/nonexistent/jev-cops.ts", here ?? ""])).toBe(SOURCE);
  });

  test("nowhere: a clear error", () => {
    expect(() => extensionSource(null, ["/nonexistent/a.ts"])).toThrow("was not found");
  });

  test("a file without the socket line is refused", () => {
    const dir = temp();
    writeFileSync(join(dir, "x.ts"), "export default () => {};\n");
    expect(() => extensionSource(null, [join(dir, "x.ts")])).toThrow("INSTALLED_SOCKET");
  });
});
