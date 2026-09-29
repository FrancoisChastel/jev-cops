/**
 * Stand-in for the `claude` process in the fake runner: started as
 * `bun claude.ts [-p] --hook <hook command> <hook args…>` (Bun would swallow a bare `--`),
 * it spawns the hook as its own child with inherited stdio, so the hook finds a parent that
 * is recognizably Claude Code (its argv names `claude.ts`) and reads `-p` there exactly as
 * under a real print-mode `claude` (mode.ts). Exits with the hook's exit code.
 */
const separator = process.argv.indexOf("--hook");
const command = separator < 0 ? [] : process.argv.slice(separator + 1);
if (command.length === 0) {
  process.stderr.write("claude.ts: no hook command after --hook\n");
  process.exit(64);
}
const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.on("SIGTERM", () => {
  child.kill("SIGKILL");
  process.exit(143);
});
process.exit(await child.exited);

export {};
