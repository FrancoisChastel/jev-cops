/**
 * The fake model API: one Bun server that answers the Anthropic Messages API (Claude
 * Code), the OpenAI Responses API (Codex, OpenCode) and OpenAI-compatible chat completions
 * (Pi, OpenCode) from a script file, and logs every request. `POST /sink/...` accepts
 * anything (the exfiltration target of the live scenarios: a request there is evidence).
 * It is never a real endpoint and never forwards anything.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anthropicResponse, countTokensResponse } from "./anthropic.ts";
import {
  type Api,
  type Conversation,
  fromAnthropic,
  fromChat,
  fromResponses,
} from "./conversation.ts";
import { condenseBody, headerFacts, type LogLine, replySummary } from "./log.ts";
import { chatResponse, modelsResponse, responsesResponse } from "./openai.ts";
import { planReply, type Reply } from "./plan.ts";
import { loadScript, type Script } from "./script.ts";

/** How one fake API instance behaves and where it logs. */
export interface FakeApiOptions {
  readonly script: Script;
  /** The request log (JSONL, one line per request). */
  readonly logPath: string;
  /** Also write every raw request body here as `<seq>.json` (null: do not). */
  readonly bodiesDir: string | null;
  /** The dummy key clients should send; the log says whether they did (never the value). */
  readonly expectedKey: string;
  readonly now?: () => Date;
}

/** A request handler plus the number of requests it logged. */
export interface FakeApi {
  fetch(req: Request): Promise<Response>;
  requests(): number;
}

type Json = Record<string, unknown>;

interface Route {
  readonly api: Api | "other";
  answer(body: Json, seq: number): { res: Response; reply: Reply | null };
}

function parseJson(text: string): Json {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
  } catch {
    return {};
  }
}

function modelRoute(
  api: Api,
  read: (b: Json) => Conversation,
  encode: (r: Reply, c: Conversation, b: Json, seq: number) => Response,
  script: Script,
): Route {
  return {
    api,
    answer(body, seq) {
      const conv = read(body);
      const reply = planReply(script, conv);
      return { res: encode(reply, conv, body, seq), reply };
    },
  };
}

function fixed(res: () => Response): Route {
  return { api: "other", answer: () => ({ res: res(), reply: null }) };
}

function route(method: string, path: string, opts: FakeApiOptions, created: number): Route {
  const { script } = opts;
  if (method === "GET" && path.endsWith("/models")) {
    return fixed(() => modelsResponse(script.models, created));
  }
  if (method === "POST" && path.startsWith("/sink"))
    return fixed(() => Response.json({ ok: true }));
  if (method !== "POST") return fixed(() => Response.json({ error: "not found" }, { status: 404 }));
  if (path.endsWith("/messages/count_tokens")) return fixed(countTokensResponse);
  if (path.endsWith("/messages")) {
    return modelRoute(
      "anthropic",
      fromAnthropic,
      (r, c, _b, seq) => anthropicResponse(r, { stream: c.stream, model: c.model, seq }),
      script,
    );
  }
  if (path.endsWith("/responses")) {
    return modelRoute(
      "responses",
      fromResponses,
      (r, c, _b, seq) => responsesResponse(r, { stream: c.stream, model: c.model, seq, created }),
      script,
    );
  }
  if (path.endsWith("/chat/completions")) {
    return modelRoute(
      "chat",
      fromChat,
      (r, c, b, seq) => {
        const so = b.stream_options;
        const includeUsage =
          typeof so === "object" && so !== null && (so as Json).include_usage === true;
        return chatResponse(r, { stream: c.stream, model: c.model, seq, created, includeUsage });
      },
      script,
    );
  }
  return fixed(() => Response.json({ error: "not found" }, { status: 404 }));
}

/** Builds the handler. Health checks (`GET /health`) are answered and not logged. */
export function createFakeApi(opts: FakeApiOptions): FakeApi {
  const now = opts.now ?? (() => new Date());
  let seq = 0;
  if (opts.bodiesDir !== null) mkdirSync(opts.bodiesDir, { recursive: true });
  return {
    requests: () => seq,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
      const text = await req.text();
      seq += 1;
      const at = now();
      if (opts.bodiesDir !== null) writeFileSync(join(opts.bodiesDir, `${seq}.json`), text);
      const created = Math.floor(at.getTime() / 1000);
      const r = route(req.method, url.pathname, opts, created);
      const body = parseJson(text);
      const { res, reply } = r.answer(body, seq);
      const facts = headerFacts(req.headers, opts.expectedKey);
      const line: LogLine = {
        seq,
        at: at.toISOString(),
        method: req.method,
        path: url.pathname,
        query: url.search,
        api: r.api,
        headers: facts.headers,
        auth: facts.auth,
        body: text === "" ? null : condenseBody(r.api, body),
        status: res.status,
        reply: replySummary(reply),
      };
      appendFileSync(opts.logPath, `${JSON.stringify(line)}\n`);
      return res;
    },
  };
}

/** The options from the environment the container sets. */
export function optionsFromEnv(env: Readonly<Record<string, string | undefined>>): FakeApiOptions {
  const script = env.FAKE_API_SCRIPT;
  if (script === undefined || script === "") throw new Error("FAKE_API_SCRIPT is required");
  const dir = env.FAKE_API_LOG_DIR ?? ".";
  mkdirSync(dir, { recursive: true });
  return {
    script: loadScript(script),
    logPath: join(dir, "requests.jsonl"),
    bodiesDir: env.FAKE_API_BODIES === "1" ? join(dir, "bodies") : null,
    expectedKey: env.FAKE_API_EXPECTED_KEY ?? "",
  };
}
