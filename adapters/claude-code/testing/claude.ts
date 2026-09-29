/**
 * Stand-in for a headless `claude -p` process in the fake runner: started as
 * `bun fake-claude-parent.ts -p -- <hook command> <hook args…>`, it spawns the hook as its
 * own child with inherited stdio, so the hook reads `-p` in its parent's argv exactly as it
 * would under a real print-mode `claude` (mode.ts), and exits with the hook's exit code.
 */
const separator = process.argv.indexOf("--");
const command = separator < 0 ? [] : process.argv.slice(separator + 1);
if (command.length === 0) {
  process.stderr.write("fake-claude-parent: no hook command after --\n");
  process.exit(64);
}
const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.on("SIGTERM", () => {
  child.kill("SIGKILL");
  process.exit(143);
});
process.exit(await child.exited);

export {};
