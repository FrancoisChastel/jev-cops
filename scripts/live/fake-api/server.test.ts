import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogLine } from "./log.ts";
import { SCRIPT_SCHEMA } from "./script.ts";
import { createFakeApi, optionsFromEnv } from "./server.ts";
import { parseSse } from "./sse-parse.ts";

const dir = mkdtempSync(join(tmpdir(), "fake-api-server-"));
const scriptPath = join(dir, "script.json");
writeFileSync(
  scriptPath,
  JSON.stringify({
    schema: SCRIPT_SCHEMA,
    models: ["gpt-fake"],
    scenarios: {
      ls: {
        steps: [
          {
            call: [
              { tool: "Bash", input: { command: "ls" } },
              { tool: "shell", input: { command: ["ls"] } },
              { tool: "bash", input: { command: "ls" } },
            ],
          },
        ],
      },
    },
  }),
);

const opts = optionsFromEnv({
  FAKE_API_SCRIPT: scriptPath,
  FAKE_API_LOG_DIR: join(dir, "logs"),
  FAKE_API_BODIES: "1",
  FAKE_API_EXPECTED_KEY: "dummy",
});
const api = createFakeApi({ ...opts, now: () => new Date("2026-09-30T00:00:00Z") });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => api.fetch(req) });
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function logLines(): LogLine[] {
  return readFileSync(opts.logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as LogLine);
}

describe("fake API over HTTP", () => {
  test("health is answered and not logged", async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
    expect(api.requests()).toBe(0);
  });

  test("Anthropic: a marked prompt gets the Bash call, streamed", async () => {
    const res = await post(
      "/v1/messages",
      {
        model: "claude-x",
        stream: true,
        system: "big system prompt",
        tools: [{ name: "Bash" }],
        messages: [{ role: "user", content: "SCENARIO:ls list" }],
      },
      { "x-api-key": "dummy", "user-agent": "claude-cli/9" },
    );
    const events = parseSse(await res.text());
    expect(events[1]?.[1]).toMatchObject({ content_block: { name: "Bash" } });
    const line = logLines().at(-1);
    expect(line).toMatchObject({
      method: "POST",
      path: "/v1/messages",
      api: "anthropic",
      status: 200,
      auth: { "x-api-key": "dummy", authorization: "absent" },
      headers: { "user-agent": "claude-cli/9" },
      reply: { kind: "call", scenario: "ls", step: 0, tool: "Bash" },
    });
    expect(line?.body).toMatchObject({ system: { chars: 17 } });
  });

  test("Responses and chat completions pick the tool each offers", async () => {
    const r = (await (
      await post("/v1/responses", {
        tools: [{ type: "function", name: "shell" }],
        input: [{ role: "user", content: "SCENARIO:ls" }],
      })
    ).json()) as { output: Array<{ name: string; arguments: string }> };
    expect(r.output[0]).toMatchObject({ name: "shell", arguments: '{"command":["ls"]}' });
    const c = parseSse(
      await (
        await post("/v1/chat/completions", {
          stream: true,
          stream_options: { include_usage: true },
          tools: [{ type: "function", function: { name: "bash" } }],
          messages: [{ role: "user", content: "SCENARIO:ls" }],
        })
      ).text(),
    );
    expect(c).toHaveLength(5);
    expect(c[1]?.[1]).toMatchObject({
      choices: [{ delta: { tool_calls: [{ function: { name: "bash" } }] } }],
    });
  });

  test("models, count_tokens, sink, unknown routes; raw bodies kept", async () => {
    expect(await (await fetch(`${base}/v1/models`)).json()).toMatchObject({
      data: [{ id: "gpt-fake" }],
    });
    expect(await (await post("/v1/messages/count_tokens", {})).json()).toEqual({
      input_tokens: 10,
    });
    expect(await (await post("/sink/upload", { secret: "x" })).json()).toEqual({ ok: true });
    expect((await post("/v2/other", {})).status).toBe(404);
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
    const bad = await fetch(`${base}/v1/messages`, { method: "POST", body: "not json" });
    expect(bad.status).toBe(200);
    const empty = await fetch(`${base}/v1/messages`, { method: "POST", body: "[1]" });
    expect(empty.status).toBe(200);
    const lines = logLines();
    expect(lines.map((l) => l.path)).toContain("/sink/upload");
    expect(lines.find((l) => l.path === "/nothing")?.body).toBeNull();
    const bodies = readdirSync(join(dir, "logs", "bodies"));
    expect(bodies).toHaveLength(api.requests());
    expect(lines.at(-1)?.at).toBe("2026-09-30T00:00:00.000Z");
  });
});

describe("optionsFromEnv", () => {
  test("requires a script; defaults", () => {
    expect(() => optionsFromEnv({})).toThrow("FAKE_API_SCRIPT");
    const o = optionsFromEnv({ FAKE_API_SCRIPT: scriptPath, FAKE_API_LOG_DIR: join(dir, "d") });
    expect(o.bodiesDir).toBeNull();
    expect(o.expectedKey).toBe("");
    expect(o.logPath).toBe(join(dir, "d", "requests.jsonl"));
  });
});
