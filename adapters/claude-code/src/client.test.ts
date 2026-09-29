import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreEvent } from "@jevdict/core";
import type { Server } from "bun";
import { VIEW_TOKEN_HEADER as DAEMON_VIEW_TOKEN_HEADER } from "../../../packages/daemon/src/holds.ts";
import { createClient, TIMEOUT, VIEW_TOKEN_HEADER } from "./client.ts";

const servers: Server<undefined>[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jvcc-c-"));
  dirs.push(dir);
  return join(dir, "d.sock");
}

function serve(fetch: (req: Request) => Response | Promise<Response>): string {
  const unix = socketPath();
  servers.push(Bun.serve({ unix, fetch }));
  return unix;
}

const EVENT = { id: "evt_01M3PP723DWGXKY6ZN6TC6ZMXZ" } as unknown as PreEvent;

describe("the Unix-socket client", () => {
  test("judge posts the event and returns status, body and the view token header", async () => {
    const seen: unknown[] = [];
    const socket = serve(async (req) => {
      seen.push({ method: req.method, path: new URL(req.url).pathname, body: await req.json() });
      return Response.json({ verdict: "hold" }, { headers: { [VIEW_TOKEN_HEADER]: "tok" } });
    });
    const reply = await createClient(socket).judge(EVENT, 1_000);
    expect(reply).toEqual({ status: 200, body: { verdict: "hold" }, viewToken: "tok" });
    expect(seen).toEqual([{ method: "POST", path: "/v1/judge", body: EVENT }]);
  });

  test("the view-token header name is the daemon's", () => {
    expect(VIEW_TOKEN_HEADER).toBe(DAEMON_VIEW_TOKEN_HEADER);
  });

  test("observe and session post to their routes; an empty body is null", async () => {
    const paths: string[] = [];
    const socket = serve((req) => {
      paths.push(new URL(req.url).pathname);
      return new Response(null, { status: 204 });
    });
    const client = createClient(socket);
    expect(await client.observe(EVENT as never, 1_000)).toEqual({
      status: 204,
      body: null,
      viewToken: null,
    });
    await client.session(EVENT as never, 1_000);
    expect(paths).toEqual(["/v1/observe", "/v1/session"]);
  });

  test("the confirm view presents the token as a Bearer header, never in the URL", async () => {
    const seen: { path: string; auth: string | null }[] = [];
    const socket = serve((req) => {
      seen.push({ path: new URL(req.url).href, auth: req.headers.get("authorization") });
      return Response.json({ raw: "ls" });
    });
    const reply = await createClient(socket).confirmView(EVENT.id, "tok", 1_000);
    expect(reply.body).toEqual({ raw: "ls" });
    expect(seen).toEqual([{ path: `http://localhost/v1/explain/${EVENT.id}`, auth: "Bearer tok" }]);
  });

  test("a body that is not JSON is undefined (the caller fails closed)", async () => {
    const socket = serve(() => new Response("not json", { status: 200 }));
    expect((await createClient(socket).judge(EVENT, 1_000)).body).toBeUndefined();
  });

  test("a daemon that never answers rejects with 'judge timeout' at the deadline", async () => {
    const socket = serve(() => new Promise<Response>(() => undefined));
    const started = performance.now();
    await expect(createClient(socket).judge(EVENT, 100)).rejects.toThrow(TIMEOUT);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a socket nobody listens on rejects with the transport error", async () => {
    const err = await createClient(socketPath())
      .judge(EVENT, 1_000)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toBe(TIMEOUT);
  });
});
