import { describe, expect, test } from "bun:test";
import { classifyArgv, INTERACTIVE_SHELL_VERB } from "./classify.ts";
import { normalizeCommand } from "./command.ts";

const OPTS = { cwd: "/work/repo", home: "/home/dev" };

const opens = (argv: string[]): boolean =>
  classifyArgv(argv).verbs.includes(INTERACTIVE_SHELL_VERB);

async function scriptOpens(command: string): Promise<boolean[]> {
  const n = await normalizeCommand(command, OPTS);
  return n.commands.map((c) => c.verbs.includes(INTERACTIVE_SHELL_VERB));
}

describe("editors and pagers run shell commands typed later (:!cmd, !cmd)", () => {
  test.each([
    [["vim", "src/app.ts"]],
    [["vi"]],
    [["nvim", "+10", "README.md"]],
    [["view", "a.log"]],
    [["vimdiff", "a", "b"]],
    [["vim", "-es", "-c", "%s/a/b/", "-c", "wq", "f"]],
    [["ex", "f"]],
    [["emacs", "-nw", "f"]],
    [["nano", "f"]],
    [["less", "app.log"]],
    [["more", "app.log"]],
    [["man", "tar"]],
    [["/usr/bin/less", "+F", "app.log"]],
    [["sudo", "vim", "/etc/hosts"]],
  ])("%p", (argv) => {
    expect(opens(argv)).toBe(true);
  });

  test.each([
    [["vim", "--version"]],
    [["less", "--help"]],
    [["man", "-k", "socket"]],
    [["man", "--where", "tar"]],
    [["cat", "app.log"]],
    [["head", "app.log"]],
  ])("%p does not", (argv) => {
    expect(opens(argv)).toBe(false);
  });

  test("the verb changes nothing else: less still reads its file", () => {
    const c = classifyArgv(["less", "app.log"]);
    expect(c).toMatchObject({ kind: "fs.read", verbs: ["less", INTERACTIVE_SHELL_VERB] });
    expect(c.paths.map((p) => [p.value, p.access])).toEqual([["app.log", "read"]]);
  });
});

describe("a pager whose output goes to a pipe or a file only copies it", () => {
  test.each([
    ["man tar | head -40", [false, false]],
    ["man tar | col -b > tar.txt", [false, false]],
    ["sudo less /var/log/syslog | grep -i error", [false, false]],
    ["less app.log > copy.log", [false]],
    ["more app.log 1>> copy.log", [false]],
    ["less app.log &> copy.log", [false]],
  ] as const)("%s", async (command, expected) => {
    expect(await scriptOpens(command)).toEqual([...expected]);
  });

  test.each([
    ["less app.log", [true]],
    ["cat app.log | less", [false, true]],
    ["less app.log 2> err.log", [true]],
    ["man tar; echo done", [true, false]],
    ["vim notes.md | cat", [true, false]],
  ] as const)("%s keeps it", async (command, expected) => {
    expect(await scriptOpens(command)).toEqual([...expected]);
  });
});

describe("database shells without a command to run (\\!, .shell, system)", () => {
  test.each([
    [["psql"]],
    [["psql", "-h", "db", "-U", "app", "appdb"]],
    [["psql", "postgres://app@db/appdb"]],
    [["mysql", "-uroot", "-psecret", "appdb"]],
    [["mysql", "-h", "db", "-p", "appdb"]],
    [["mariadb", "appdb"]],
    [["sqlite3", "app.db"]],
    [["sqlite3"]],
    [["sqlite3", "-cmd", ".mode csv", "app.db"]],
    [["sqlite3", "-batch", "-separator", "|", "app.db"]],
  ])("%p", (argv) => {
    expect(opens(argv)).toBe(true);
  });

  test.each([
    [["psql", "-c", "select 1", "appdb"]],
    [["psql", "--command=select 1"]],
    [["psql", "-cselect 1"]],
    [["psql", "-f", "migrate.sql", "appdb"]],
    [["psql", "--file=migrate.sql"]],
    [["psql", "-l"]],
    [["psql", "--version"]],
    [["mysql", "-e", "show tables", "appdb"]],
    [["mysql", "--execute=show tables"]],
    [["mysql", "-uroot", "-eshow tables"]],
    [["mariadb", "--version"]],
    [["sqlite3", "app.db", "select 1"]],
    [["sqlite3", "app.db", ".dump"]],
    [["sqlite3", "-init", "x.sql", "-cmd", ".mode csv", "app.db", "select 1"]],
    [["sqlite3", "-version"]],
  ])("%p does not", (argv) => {
    expect(opens(argv)).toBe(false);
  });
});

describe("docker/podman/kubectl exec -i into a shell (or with no command)", () => {
  test.each([
    [["docker", "exec", "-it", "web", "bash"]],
    [["docker", "exec", "-ti", "web", "sh", "-l"]],
    [["docker", "exec", "--interactive", "--tty", "web", "python3"]],
    [["docker", "exec", "-i", "-u", "root", "-w", "/app", "web", "psql"]],
    [["docker", "-H", "tcp://h:2375", "exec", "-it", "web", "bash"]],
    [["docker", "container", "exec", "-it", "web", "zsh"]],
    [["docker", "exec", "-it", "web"]],
    [["podman", "exec", "-it", "web", "bash"]],
    [["kubectl", "exec", "-it", "pod/web", "--", "bash"]],
    [["kubectl", "-n", "prod", "exec", "-it", "web", "-c", "app", "--", "sh"]],
    [["kubectl", "exec", "--stdin", "--tty", "web", "--", "mysql"]],
    [["kubectl", "exec", "-i", "web"]],
  ])("%p", (argv) => {
    expect(opens(argv)).toBe(true);
  });

  test.each([
    [["docker", "exec", "web", "bash"]],
    [["docker", "exec", "-t", "web", "bash"]],
    [["docker", "exec", "-it", "web", "sh", "-c", "ls /app"]],
    [["docker", "exec", "-it", "web", "ls", "/app"]],
    [["docker", "exec", "-it", "-e", "bash=1", "web", "env"]],
    [["docker", "ps"]],
    [["docker", "run", "--rm", "img", "bash"]],
    [["kubectl", "exec", "web", "--", "bash"]],
    [["kubectl", "exec", "-it", "web", "--", "cat", "/etc/hosts"]],
    [["kubectl", "get", "pods", "-it"]],
  ])("%p does not", (argv) => {
    expect(opens(argv)).toBe(false);
  });

  test("the docker verbs and kind are unchanged", () => {
    expect(classifyArgv(["docker", "exec", "-it", "web", "bash"])).toMatchObject({
      kind: "exec",
      verbs: ["docker", "exec", INTERACTIVE_SHELL_VERB],
    });
  });
});
