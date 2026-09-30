import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { hostname as osHostname } from "node:os";
import { type ConnectionOptions, connect, type TLSSocket } from "node:tls";
import type { AuditLine } from "../audit-line.ts";
import type { SyslogSettings } from "../config-audit.ts";
import type { ForwardTransport } from "./forwarder.ts";
import { octetFrame, type SyslogFormat, syslogMessages } from "./syslog-format.ts";

/** Budgets of the TLS connection (tests shorten them). */
export interface SyslogTimeouts {
  readonly connectMs: number;
  /** A write the receiver does not drain within this is a lost connection. */
  readonly writeMs: number;
  /** How long a graceful close may take before the socket is destroyed. */
  readonly closeMs: number;
}

const DEFAULT_TIMEOUTS: SyslogTimeouts = { connectMs: 10_000, writeMs: 10_000, closeMs: 1_000 };

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The TLS options: the receiver's certificate must chain to `ca`; a client certificate if set. */
function tlsOptions(s: SyslogSettings): ConnectionOptions {
  const read = (path: string, what: string) => {
    try {
      return readFileSync(path);
    } catch (cause) {
      throw new Error(`cannot read the syslog ${what} ${path}: ${message(cause)}`);
    }
  };
  const client =
    s.cert !== null && s.key !== null
      ? { cert: read(s.cert, "client certificate"), key: read(s.key, "client key") }
      : {};
  const servername = s.serverName ?? (isIP(s.host) === 0 ? s.host : undefined);
  return {
    host: s.host,
    port: s.port,
    ca: read(s.ca, "CA file"),
    ...client,
    ...(servername === undefined ? {} : { servername }),
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  };
}

/**
 * The `syslog` forwarder's destination (D-103): RFC 5424 messages, RFC 5425 octet-counted
 * framing, over TLS only, the server verified against `ca_file` (never system roots alone,
 * never unverified). Syslog has no acknowledgement, so a lost connection makes the
 * forwarder resend an overlap; duplicates carry the same seq and hash.
 */
export class SyslogTransport implements ForwardTransport {
  readonly kind = "syslog";
  readonly target: string;
  readonly resendOverlap: number;
  private socket: TLSSocket | null = null;
  private dropped: (reason: string) => void = () => {};
  private readonly format: SyslogFormat;
  private readonly timeouts: SyslogTimeouts;

  constructor(
    private readonly settings: SyslogSettings,
    opts: { hostname?: string; procId?: string; timeouts?: Partial<SyslogTimeouts> } = {},
  ) {
    this.target = settings.host.includes(":")
      ? `[${settings.host}]:${settings.port}`
      : `${settings.host}:${settings.port}`;
    this.resendOverlap = settings.resendOverlap;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.format = {
      facility: settings.facility,
      hostname: opts.hostname ?? osHostname(),
      appName: settings.appName,
      procId: opts.procId ?? String(process.pid),
      enterpriseNumber: settings.enterpriseNumber,
      maxMessageBytes: settings.maxMessageBytes,
    };
  }

  connect(): Promise<void> {
    const opts = tlsOptions(this.settings);
    return new Promise((resolve, reject) => {
      const socket = connect(opts);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`syslog connect to ${this.target} timed out`));
      }, this.timeouts.connectMs);
      socket.once("error", (cause) => {
        clearTimeout(timer);
        reject(cause);
      });
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        this.adopt(socket);
        resolve();
      });
    });
  }

  delivered(): null {
    return null;
  }

  write(lines: readonly AuditLine[]): Promise<void> {
    const socket = this.socket;
    if (socket === null || socket.destroyed) return Promise.reject(new Error("not connected"));
    const frames = lines.flatMap((l) => syslogMessages(l, this.format).map(octetFrame));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(`syslog write to ${this.target} not drained in ${this.timeouts.writeMs} ms`),
        );
      }, this.timeouts.writeMs);
      socket.write(Buffer.concat(frames), (cause) => {
        clearTimeout(timer);
        if (cause === null || cause === undefined) resolve();
        else reject(cause);
      });
    });
  }

  onDrop(callback: (reason: string) => void): void {
    this.dropped = callback;
  }

  async close(): Promise<boolean> {
    const socket = this.socket;
    this.socket = null;
    if (socket === null || socket.destroyed) return false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, this.timeouts.closeMs);
      socket.once("close", (hadError: boolean) => {
        clearTimeout(timer);
        resolve(!hadError);
      });
      socket.end();
    });
  }

  /** The connected socket: a later error or close is a drop the forwarder hears about. */
  private adopt(socket: TLSSocket): void {
    this.socket = socket;
    socket.removeAllListeners("error");
    socket.on("error", (cause) => this.lose(socket, message(cause)));
    socket.on("close", () => this.lose(socket, "the receiver closed the connection"));
  }

  private lose(socket: TLSSocket, reason: string): void {
    if (this.socket !== socket) return;
    this.socket = null;
    socket.destroy();
    this.dropped(reason);
  }
}
