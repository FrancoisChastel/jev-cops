# Live testing in Docker

Live tests run real harness binaries (Claude Code, Codex, OpenCode, Pi) against jev-cops.
They run **only inside Docker containers** built from this repository, never on the
developer's machine (D-115: "don't mess up my claude, codex etc. — use docker to test").
`bun test` and CI never start them.

## What is where

| Path | What it is |
|---|---|
| `scripts/live/fake-api/` | The fake model API: one Bun server speaking the Anthropic Messages API (Claude Code, SSE), the OpenAI Responses API (Codex) and OpenAI-compatible chat completions (Pi, OpenCode), driven by a script file, logging every request. Unit-tested in `bun test`. |
| `scripts/live/scenarios.json` | The script: what the "model" answers, scenario by scenario. |
| `scripts/live/pack.ts` | Packs every publishable package with the release tooling (`scripts/pack-lib.ts`) into the images' build context, and fails when a tarball breaks a release rule. |
| `scripts/live/check.ts` | Assertions over copied-out artifacts: judged calls in an audit log, what the model read, human-only text in any request body, request digests. |
| `scripts/live/report.ts` | Renders `docs/captures/live/e2e-report.md` from a run's recorded steps. |
| `scripts/live/build.sh` | Packs the repo and builds the images (the only step with network access). |
| `scripts/live/run.sh <harness> <scenario>` | One scenario, captured into `docs/captures/live/<harness>-<scenario>/`. |
| `scripts/live/e2e.sh` | The full end-to-end suite and its report. |
| `docker/*.Dockerfile` | `base` (Node 22, Bun 1.3.13, git, tmux, procps, python3, user `dev`), one image per harness, `fake-api`, `syslog` (rsyslog over TLS). |
| `docker/compose.live.yml` | The stack: an internal network, the fake API, the syslog receiver, one service per harness. |
| `docker/files/live/` | Helpers copied into the harness images: `prep-world.sh`, `copsd.sh`, `run-harness.sh`, `tmux-claude.sh`. |

## Isolation guarantees

- **No host harness is touched.** Nothing runs, installs or configures the host's
  `claude`, `codex`, `opencode`, `pi`, `skillspector`, `uv`, launchd or systemd. The host
  only runs `bun` (to pack the repository), `docker build`, `docker compose`, `docker exec`
  and `docker cp`, and reads the artifacts it copied out.
- **No host directory is mounted** into any container. Images are built from the repo;
  artifacts leave through `docker cp`. The one shared volume (`certs`) carries the syslog
  receiver's throwaway CA certificate, read-only for the harness containers. Step 0.3 of
  the e2e suite checks every container's mounts.
- **No egress at run time.** Every service is on `live`, a Docker network with
  `internal: true`: no route out, no external DNS (step 0.3 checks both). Network access
  happens only during `docker build`, to install packages.
- **Dummy keys, fake model.** The only "model" any harness can reach is the fake API;
  every key is `dummy-jev-cops-live-key-not-a-real-credential-0000`. The request log
  records whether each request carried the dummy (`auth` facts), never a header value.
- **Everything is labelled.** Images are `jev-cops-live-*:local` with the label
  `jev-cops.live=1`; the compose project is `jev-cops-live`. Clean up only those:
  `docker compose -p jev-cops-live -f docker/compose.live.yml down -v` and
  `docker image rm $(docker image ls -q --filter label=jev-cops.live=1)`.

## Running

Requirements: Docker (Desktop 29.4, linux/arm64, is what the captures ran on) and Bun on
the host. The base images are pinned by their multi-arch index digest and every harness
package ships linux x64 and arm64 builds, so `JEV_COPS_LIVE_PLATFORM=linux/amd64` builds the
amd64 images (only the base image was built and run for amd64 so far, under emulation).

```bash
JEV_COPS_LIVE=1 scripts/live/build.sh                     # pack + build every image
JEV_COPS_LIVE=1 scripts/live/run.sh claude-code benign-ls # one captured scenario
JEV_COPS_LIVE=1 scripts/live/e2e.sh                       # the whole suite + report
```

Every script refuses to run without `JEV_COPS_LIVE=1`. `JEV_COPS_LIVE_WORK` (default
`$TMPDIR/jev-cops-live`) holds the tarballs, build logs and the raw artifacts of each run
(full request bodies included); `JEV_COPS_LIVE_NO_BUILD=1` reuses built images;
`JEV_COPS_LIVE_KEEP=1` leaves the e2e stack up for inspection.

Scenarios of `run.sh`: `claude-code` `benign-ls`, `force-push-main-headless`,
`write-settings-kill`; `pi` `fake-api-roundtrip`, `force-push-main-headless`; `codex` and
`opencode` `fake-api-roundtrip` (their adapters do not exist yet: the capture proves the
harness in the container reaches the fake API and runs one scripted `ls`).

## How a run works

1. `build.sh` packs every publishable package (`bun pm pack`, the release rules of
   `scripts/pack-lib.ts`) and builds the images. Each harness image installs the harness
   from its official npm package at a pinned version, then installs jev-cops **from the
   local tarballs** with `bun add -g`, exactly as a user would (the `@jev-cops/*`
   dependencies resolve to their tarballs through Bun's `overrides`; nothing is published).
2. The stack starts; `prep-world.sh` creates a git repository on `main` with a local bare
   remote (a push never leaves the container), the files the scenarios read, and the
   harness's own configuration pointing at the fake API (below).
3. `copsd.sh start` starts `copsd --enforce` on the installed starter policies (with
   `--forward`, `[audit.forward]` syslog over TLS to the receiver, pinning its CA);
   `cops install <harness>` runs in the container.
4. `run-harness.sh` drives the harness headlessly (`claude -p … --output-format
   stream-json`, `pi -p --mode json`, `codex exec --json`, `opencode run --format json`);
   `tmux-claude.sh` drives an interactive `claude` for the ask dialog and ConfigChange.
5. The audit log, the fake API's request log and the transcripts are copied out,
   checked (`check.ts`) and redacted (the host's home and repository paths; container
   hostnames are fixed by the compose file).

### Harness configuration in the containers

| Harness | Pointed at the fake API by |
|---|---|
| Claude Code | `ANTHROPIC_BASE_URL=http://fake-api.live.internal:8080`, `ANTHROPIC_API_KEY=<dummy>` (its last 20 characters pre-approved in `~/.claude.json`, with onboarding done and the repo trusted), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1` |
| Codex | `~/.codex/config.toml`: `model_provider = "fake"`, `[model_providers.fake] base_url = ".../v1"`, `wire_api = "responses"`, `env_key = "FAKE_API_KEY"`, `approval_policy = "never"`, `sandbox_mode = "danger-full-access"` (the container is the sandbox), the repo trusted |
| OpenCode | `~/.config/opencode/opencode.json`: provider `fake` with the bundled `@ai-sdk/openai-compatible`, `baseURL .../v1`, `apiKey {env:FAKE_API_KEY}`; `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_DEFAULT_PLUGINS` |
| Pi | `~/.pi/agent/models.json`: provider `fake`, `api: "openai-completions"`, `baseUrl .../v1`, `apiKey "$FAKE_API_KEY"`; `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` |

Claude Code 2.1.286 runs `-p` sessions in **auto** permission mode; its classifier sends
the transcript to the model endpoint and the fake model cannot answer it, so auto mode
blocks. Headless scenarios whose command must run use `--permission-mode manual` plus an
allow rule for exactly the scripted command: Claude Code's own layer lets it through and
jev-cops alone decides.

## The fake model API

A request's last user prompt carrying `SCENARIO:<name>` starts that scenario; every later
request of the same turn (its last user message carries tool results) gets the next step:
a tool call (the first alternative whose tool the request offers, so one scenario serves
`Bash`, `bash`, `exec_command`…) or a text answer. The planner is stateless: it reads only
the conversation, so a retried request gets the same answer and harnesses never mix. A
request that offers none of the step's tools (Claude Code's title and classifier calls)
gets the default text.

```json
{
  "schema": "jev-cops.fake-api-script/1",
  "scenarios": {
    "ls": { "steps": [
      { "call": [
        { "tool": "Bash", "input": { "command": "ls", "description": "List files" } },
        { "tool": "exec_command", "input": { "cmd": "ls" } }
      ] },
      { "text": "Listed the files." }
    ] }
  }
}
```

Routes: `POST …/messages` (Anthropic, streamed when `stream: true`), `…/messages/count_tokens`,
`…/responses`, `…/chat/completions`, `GET …/models`, `POST /sink/…` (the exfiltration
target: any request there is evidence), `GET /health` (not logged). Every other request is
logged and answered 404. The log (`requests.jsonl`) keeps method, path, query, every header
except credentials (`authorization`, `x-api-key`, `api-key`, `proxy-authorization`, `cookie`
become `absent`/`dummy`/`other`), the body with the harness-owned bulk (system prompt,
instructions, tool schemas) condensed to a size, a SHA-256 and the tool names, and the
planned reply. With `FAKE_API_BODIES=1` (the image's default) every raw body is also kept:
`check.ts leaks` searches those for anything only a human may see (a score, the confirm
view, a `cops explain` id).

Environment: `FAKE_API_SCRIPT` (required), `FAKE_API_LOG_DIR`, `FAKE_API_BODIES`,
`FAKE_API_EXPECTED_KEY`, `FAKE_API_HOST`, `FAKE_API_PORT`.

## Captures

- `docs/captures/live/<harness>-<scenario>/` (`run.sh`): `README.txt` (versions),
  `transcript-*.jsonl` and `argv-*.txt`, `audit.jsonl`, `judged.txt`,
  `requests.digest.jsonl` (per request: path, auth facts, user agent, model, tool count,
  reply, and what the model read in its last turn), `model-saw.txt`, `install.out`.
- `docs/captures/live/e2e-report.md` and `docs/captures/live/e2e/` (`e2e.sh`): one
  evidence file per step, the audit logs, transcripts, tmux screens, the rsyslog copy and
  the request digest. [`docs/captures/claude-code-docker.md`](./captures/claude-code-docker.md)
  summarizes the Claude Code results.

## Plugging in the next captures

- **M2 (OpenShell, PLAN-M2 §3 step 9).** Add an OpenShell gateway service to the compose
  file once Docker Desktop host networking is on (it is off on the owner's machine today);
  `cops openshell create` then runs inside the harness container and the e2e's step 6
  grows from `compile --dry-run` to the sandbox assertions of PLAN-M2 §9 (T1, T4, T7, T12,
  T13). The fake API already accepts `/sink/…` for the "non-allowlisted host" probes; a
  second sink service can stand in for a judge-provider host.
- **M3 (Codex, OpenCode, Pi parity, PLAN-M3 §6.3).** The Codex and OpenCode images and
  their round trips exist; once `cops install codex|opencode` exist, add their verdict
  scenarios to `e2e.sh` by copying the Pi phase (the scenarios in `scenarios.json` already
  carry `exec_command`/`bash` alternatives; add `apply_patch` steps for Codex). The "fake
  Responses API" of PLAN-M3 §6.3 is `scripts/live/fake-api/`.
- **Setup (PLAN-SETUP §10, the timed first run).** Add a `setup` image (base + `uv`),
  run `bunx jev-cops setup` from the packed tarballs inside it, time it, and drive a real
  `claude` against the fake API for the skill-install scenarios; SkillSpector installs
  during `docker build` (it needs the network) and runs offline in the container.
