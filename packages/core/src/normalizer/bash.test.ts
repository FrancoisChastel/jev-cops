import { describe, expect, test } from "bun:test";
import { type ParsedScript, parseScript } from "./bash.ts";

const HOME = "/home/dev";

function parse(source: string): Promise<ParsedScript> {
  return parseScript(source, HOME);
}

function argvs(script: ParsedScript): string[][] {
  return script.commands.map((c) => c.words.map((w) => w.value));
}

function reasons(script: ParsedScript): string[] {
  return script.opaque.map((o) => o.reason);
}

describe("parseScript: flattening", () => {
  test("a simple command yields its argv", async () => {
    expect(argvs(await parse("ls -la /tmp"))).toEqual([["ls", "-la", "/tmp"]]);
  });

  test("a pipeline of three commands yields three commands in order with positions", async () => {
    // Act
    const script = await parse("cat f | grep x | wc -l");

    // Assert
    expect(argvs(script)).toEqual([
      ["cat", "f"],
      ["grep", "x"],
      ["wc", "-l"],
    ]);
    expect(script.commands.map((c) => [c.pipe?.index, c.pipe?.size])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    const ids = new Set(script.commands.map((c) => c.pipe?.id));
    expect(ids.size).toBe(1);
  });

  test("&&, || and ; lists keep source order", async () => {
    const script = await parse("cd a && make; rm x || echo fail");
    expect(argvs(script)).toEqual([["cd", "a"], ["make"], ["rm", "x"], ["echo", "fail"]]);
  });

  test("a subshell and a brace group are flattened", async () => {
    const script = await parse("(rm a; rm b) && { touch c; }");
    expect(argvs(script)).toEqual([
      ["rm", "a"],
      ["rm", "b"],
      ["touch", "c"],
    ]);
  });

  test("if, for, while and function bodies are flattened", async () => {
    const source =
      "if test -f a; then rm a; fi; for i in 1 2; do touch x; done; while false; do ls; done; f() { rm -rf y; }";
    const names = argvs(await parse(source)).map((argv) => argv[0]);
    expect(names).toEqual(["test", "rm", "touch", "false", "ls", "rm"]);
  });

  test("a negated command is still a command", async () => {
    expect(argvs(await parse("! grep -q x f"))).toEqual([["grep", "-q", "x", "f"]]);
  });

  test("a nested pipeline under a redirect is flattened into the outer pipeline", async () => {
    const script = await parse("a | b > f | c");
    expect(script.commands.map((c) => c.pipe?.index)).toEqual([0, 1, 2]);
    expect(script.commands.map((c) => c.pipe?.size)).toEqual([3, 3, 3]);
  });

  test("keeps each command's raw source slice", async () => {
    const script = await parse("rm  -rf   ./x && ls");
    expect(script.commands.map((c) => c.raw)).toEqual(["rm  -rf   ./x", "ls"]);
  });
});

describe("parseScript: words", () => {
  test("removes quotes and processes escapes", async () => {
    const script = await parse(`echo 'a b' "c\\"d" e\\ f $'g\\nh' 'i'"j"k`);
    expect(argvs(script)).toEqual([["echo", "a b", 'c"d', "e f", "g\nh", "ijk"]]);
  });

  test("variable assignments before a command go to env, not argv", async () => {
    // Act
    const script = await parse('FOO=1 BAR="x y" env A=2 sh -c "rm -rf /tmp/x"');

    // Assert
    expect(script.commands[0]?.env).toEqual({ FOO: "1", BAR: "x y" });
    expect(argvs(script)).toEqual([["env", "A=2", "sh", "-c", "rm -rf /tmp/x"]]);
  });

  test("expands ~, ~/, $HOME and ${HOME} with the configured home", async () => {
    const script = await parse('ls ~ ~/y $HOME ${HOME}/x "$HOME/z" ~root');
    expect(argvs(script)).toEqual([
      ["ls", HOME, `${HOME}/y`, HOME, `${HOME}/x`, `${HOME}/z`, "~root"],
    ]);
    expect(script.opaque).toEqual([]);
  });

  test("keeps other expansions verbatim, marks them non-literal and flags them", async () => {
    // Act
    const script = await parse('rm -rf $DIR/x "${TARGET:-y}" a$1');

    // Assert
    expect(argvs(script)).toEqual([["rm", "-rf", "$DIR/x", "${TARGET:-y}", "a$1"]]);
    expect(script.commands[0]?.words.map((w) => w.literal)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(script.opaque).toEqual([
      { reason: "dynamic-expansion", span: "$DIR" },
      { reason: "dynamic-expansion", span: "${TARGET:-y}" },
      { reason: "dynamic-expansion", span: "$1" },
    ]);
  });

  test("an out-of-range $'\\U…' escape decodes to U+FFFD instead of failing", async () => {
    const script = await parse("echo $'\\U7FFFFFFF'");
    expect(argvs(script)).toEqual([["echo", "\uFFFD"]]);
    expect(script.opaque).toEqual([]);
  });

  test("an escaped dollar is a literal, not an expansion", async () => {
    const script = await parse("echo \\$HOME");
    expect(argvs(script)).toEqual([["echo", "$HOME"]]);
    expect(script.opaque).toEqual([]);
  });
});

describe("parseScript: opaque constructs", () => {
  test("$(…) is flagged and its inner commands are included first", async () => {
    // Act
    const script = await parse("rm -rf $(cat list.txt)");

    // Assert
    expect(script.opaque).toEqual([{ reason: "command-substitution", span: "$(cat list.txt)" }]);
    expect(argvs(script)).toEqual([
      ["cat", "list.txt"],
      ["rm", "-rf", "$(cat list.txt)"],
    ]);
    expect(script.commands[1]?.words[2]?.literal).toBe(false);
  });

  test("backticks are flagged like $(…)", async () => {
    const script = await parse("echo `whoami`");
    expect(script.opaque).toEqual([{ reason: "command-substitution", span: "`whoami`" }]);
    expect(argvs(script)[0]).toEqual(["whoami"]);
  });

  test("$(…) inside double quotes and in assignments is flagged", async () => {
    const script = await parse('X=$(id) echo "a$(id -u)b"');
    expect(reasons(script)).toEqual(["command-substitution", "command-substitution"]);
  });

  test("process substitution is flagged in both directions", async () => {
    const script = await parse("diff <(ls a) >(cat)");
    expect(reasons(script)).toEqual(["process-substitution", "process-substitution"]);
    expect(argvs(script).map((a) => a[0])).toEqual(["ls", "cat", "diff"]);
  });

  test("arithmetic expansion is dynamic", async () => {
    const script = await parse("echo $((1 + 2))");
    expect(reasons(script)).toEqual(["dynamic-expansion"]);
  });
});

describe("parseScript: redirects and heredocs", () => {
  test("file redirects carry op and expanded target", async () => {
    const script = await parse("ls >> ~/out 2>&1 < in.txt");
    expect(script.commands[0]?.redirects.map((r) => [r.op, r.target.value])).toEqual([
      [">>", `${HOME}/out`],
      ["2>&", "1"],
      ["<", "in.txt"],
    ]);
  });

  test("a redirect on a group applies to every command in it", async () => {
    const script = await parse("{ echo a; echo b; } > f");
    expect(script.commands.map((c) => c.redirects.map((r) => r.target.value))).toEqual([
      ["f"],
      ["f"],
    ]);
  });

  test("a heredoc to a file keeps the body and the file redirect", async () => {
    // Act
    const script = await parse("cat <<EOF > /tmp/x.sh\nrm -rf /\nEOF");

    // Assert
    const cat = script.commands[0];
    expect(cat?.heredocs).toEqual(["rm -rf /\n"]);
    expect(cat?.redirects.map((r) => [r.op, r.target.value])).toEqual([[">", "/tmp/x.sh"]]);
  });

  test("a heredoc piped into a shell makes a two-stage pipeline", async () => {
    const script = await parse("cat <<'EOF' | sh\nrm -rf /\nEOF\n");
    expect(argvs(script)).toEqual([["cat"], ["sh"]]);
    expect(script.commands.map((c) => c.pipe?.index)).toEqual([0, 1]);
  });

  test("a command chained after a heredoc with && is still found", async () => {
    const script = await parse("cat <<EOF && rm x\nbody\nEOF");
    expect(argvs(script)).toEqual([["cat"], ["rm", "x"]]);
  });

  test("an unquoted heredoc body is scanned for substitutions, a quoted one is not", async () => {
    const open = await parse("cat > x <<EOF\nhi $(id)\nEOF");
    const closed = await parse("cat > x <<'EOF'\nhi $(id)\nEOF");
    expect(reasons(open)).toEqual(["command-substitution"]);
    expect(reasons(closed)).toEqual([]);
  });

  test("a herestring is recorded as a heredoc body", async () => {
    const script = await parse("bash <<< 'rm -rf /'");
    expect(script.commands[0]?.heredocs).toEqual(["rm -rf /"]);
  });
});

describe("parseScript: background and errors", () => {
  test("a trailing & marks the command as background", async () => {
    const script = await parse("sleep 5 & ls");
    expect(script.commands.map((c) => c.background)).toEqual([true, false]);
  });

  test("an unterminated string keeps the parsed command and flags parse-error", async () => {
    const script = await parse('echo "unterminated');
    expect(argvs(script)).toEqual([["echo"]]);
    expect(reasons(script)).toEqual(["parse-error"]);
  });

  test("a missing command after && is flagged and skipped", async () => {
    const script = await parse("rm -rf ./x ; echo hi &&");
    expect(argvs(script)).toEqual([
      ["rm", "-rf", "./x"],
      ["echo", "hi"],
    ]);
    expect(reasons(script)).toContain("parse-error");
  });

  test("a totally unparseable input yields one non-literal command with the raw text", async () => {
    // Act
    const script = await parse(")))");

    // Assert
    expect(argvs(script)).toEqual([[")))"]]);
    expect(script.commands[0]?.words[0]?.literal).toBe(false);
    expect(script.opaque).toEqual([{ reason: "parse-error", span: ")))" }]);
  });

  test("an empty command yields nothing", async () => {
    const script = await parse("   ");
    expect(script).toEqual({ commands: [], opaque: [] });
  });
});
