/**
 * Test support: the fake `skillspector` compiled once (`bun build --compile`, cached in the
 * OS temp dir by a hash of its sources and the Bun version), and a throw-away world with
 * a `HOME` and skill directories whose `fake-scenario` file picks the fake's answer.
 * Nothing here touches the real home directory or runs the real SkillSpector.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The fake's source. */
export const FAKE_SOURCE = join(import.meta.dir, "fake-skillspector.ts");
const FIXTURES = join(import.meta.dir, "fixtures");

let pending: Promise<string> | null = null;

function sourceHash(): string {
  const hash = createHash("sha256").update(Bun.version).update(readFileSync(FAKE_SOURCE));
  for (const name of readdirSync(FIXTURES).sort()) {
    hash.update(name).update(readFileSync(join(FIXTURES, name)));
  }
  return hash.digest("hex").slice(0, 16);
}

async function build(): Promise<string> {
  const dir = join(tmpdir(), `jev-cops-fake-skillspector-${sourceHash()}`);
  const out = join(dir, "skillspector");
  if (existsSync(out)) return out;
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `skillspector.${process.pid}.tmp`);
  const proc = Bun.spawn([process.execPath, "build", "--compile", FAKE_SOURCE, "--outfile", tmp], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`cannot compile the fake skillspector: ${stderr}`);
  renameSync(tmp, out);
  return out;
}

/** The compiled fake's absolute path; compiled on first use, then reused. */
export function fakeSkillspector(): Promise<string> {
  pending ??= build();
  return pending;
}

/** One recorded call of the fake. */
export interface FakeCall {
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
}

/** A temp `HOME` and a place for skill directories. */
export interface ScanWorld {
  readonly root: string;
  readonly home: string;
  /** A skill directory with a `SKILL.md` and the fake's `scenario`. */
  skill(scenario: string): string;
  /** Every call the fake recorded under this `HOME`, oldest first. */
  calls(): FakeCall[];
  dispose(): void;
}

let counter = 0;

/** Creates a world; call `dispose` in `afterAll`/`afterEach`. */
export function scanWorld(): ScanWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jvscan-")));
  const home = join(root, "home");
  mkdirSync(home);
  const log = join(home, "fake-skillspector.calls.jsonl");
  return {
    root,
    home,
    skill(scenario) {
      counter += 1;
      const dir = join(root, `skill-${counter}-${scenario}`);
      mkdirSync(dir);
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${scenario}\n---\nA test skill.\n`);
      writeFileSync(join(dir, "fake-scenario"), scenario);
      return dir;
    },
    calls() {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as FakeCall);
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
