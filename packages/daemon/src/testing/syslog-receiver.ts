/**
 * An in-test RFC 5425 receiver: syslog over TLS on 127.0.0.1 with a throwaway self-signed
 * certificate, octet-counted framing checked strictly. It never talks to a real syslog
 * server. `stop`/`start` take it down and bring it back on the same port (an outage).
 */
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { octetFrame } from "../audit-forward/syslog-format.ts";
import { splitOctetFrames } from "../audit-forward/syslog-parse.ts";
import type { AuditForward } from "../config-audit.ts";
import { selfSignedCert, type TestCert } from "./tls-cert.ts";

/** What the receiver asks of its clients. */
export interface ReceiverOptions {
  /** Require a client certificate that chains to this CA. */
  readonly clientCa?: string;
}

/** A running receiver. */
export interface SyslogReceiver {
  readonly port: number;
  /** Its certificate: what a client pins as `ca_file`. */
  readonly cert: TestCert;
  /** Every complete message, in arrival order, across connections. */
  messages(): string[];
  /** The frames as a raw capture would hold them (RFC 5425 stream). */
  frames(): Buffer;
  /** Framing errors (a connection with one is dropped). */
  errors(): string[];
  /** Connections accepted so far. */
  connections(): number;
  /** Stops accepting and drops every open connection. */
  stop(): Promise<void>;
  /** Listens again on the same port. */
  start(): Promise<void>;
  close(): Promise<void>;
}

interface State {
  readonly messages: Buffer[];
  readonly errors: string[];
  readonly sockets: Set<TLSSocket>;
  accepted: number;
}

function onConnection(state: State, socket: TLSSocket): void {
  state.accepted += 1;
  state.sockets.add(socket);
  let pending: Buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    const split = splitOctetFrames(Buffer.concat([pending, chunk]));
    state.messages.push(...split.messages);
    pending = split.rest;
    if (split.error !== null) {
      state.errors.push(split.error);
      socket.destroy();
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => state.sockets.delete(socket));
}

function listen(
  state: State,
  cert: TestCert,
  opts: ReceiverOptions,
  port: number,
): Promise<Server> {
  const tlsOpts = {
    key: cert.key,
    cert: cert.cert,
    ...(opts.clientCa === undefined
      ? {}
      : { requestCert: true, rejectUnauthorized: true, ca: opts.clientCa }),
  };
  const server = createServer(tlsOpts, (s) => onConnection(state, s));
  server.on("tlsClientError", (e) => state.errors.push(`tls: ${e.message}`));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: Server, state: State): Promise<void> {
  for (const s of state.sockets) s.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * An `[audit.forward] kind = "syslog"` to `r`, its CA pinned to `r`'s certificate (written
 * into `dir`) and its cursor in `dir`.
 */
export function syslogForwardTo(
  r: SyslogReceiver,
  dir: string,
  over: Partial<AuditForward> = {},
): AuditForward {
  const ca = join(dir, `receiver-${r.port}.pem`);
  writeFileSync(ca, r.cert.cert);
  return {
    kind: "syslog",
    target: `127.0.0.1:${r.port}`,
    required: false,
    maxLagLines: 1_000,
    maxLagMs: 600_000,
    cursor: join(dir, "forward.cursor"),
    syslog: {
      host: "127.0.0.1",
      port: r.port,
      ca,
      cert: null,
      key: null,
      serverName: null,
      facility: 16,
      appName: "copsd",
      enterpriseNumber: 32473,
      maxMessageBytes: 8192,
      resendOverlap: 100,
    },
    ...over,
  };
}

/** Starts a receiver on a free port of 127.0.0.1. */
export async function startSyslogReceiver(opts: ReceiverOptions = {}): Promise<SyslogReceiver> {
  const cert = selfSignedCert();
  const state: State = { messages: [], errors: [], sockets: new Set(), accepted: 0 };
  let server: Server | null = await listen(state, cert, opts, 0);
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    cert,
    messages: () => state.messages.map((m) => m.toString("utf8")),
    frames: () => Buffer.concat(state.messages.map(octetFrame)),
    errors: () => [...state.errors],
    connections: () => state.accepted,
    async stop() {
      if (server !== null) await closeServer(server, state);
      server = null;
    },
    async start() {
      server ??= await listen(state, cert, opts, port);
    },
    async close() {
      if (server !== null) await closeServer(server, state);
      server = null;
    },
  };
}
