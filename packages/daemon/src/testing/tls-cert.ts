/**
 * Throwaway self-signed TLS certificates for tests, built with `node:crypto` alone (no
 * openssl, no dependency): an ECDSA P-256 key, a minimal X.509 v3 certificate for
 * `localhost` and 127.0.0.1 with CA:TRUE, so the certificate is its own trust anchor
 * (what `[audit.forward] ca_file` pins). Valid for an hour; never written outside a test.
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

/** A PEM certificate and its PKCS #8 PEM private key. */
export interface TestCert {
  readonly cert: string;
  readonly key: string;
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);

function oid(dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(d: Date): Buffer {
  return tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
}

const ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const COMMON_NAME = "2.5.4.3";
const BASIC_CONSTRAINTS = "2.5.29.19";
const SUBJECT_ALT_NAME = "2.5.29.17";

function extensions(): Buffer {
  const yes = tlv(0x01, Buffer.from([0xff]));
  const ca = seq(oid(BASIC_CONSTRAINTS), yes, tlv(0x04, seq(yes)));
  const names = seq(tlv(0x82, Buffer.from("localhost")), tlv(0x87, Buffer.from([127, 0, 0, 1])));
  const san = seq(oid(SUBJECT_ALT_NAME), tlv(0x04, names));
  return tlv(0xa3, seq(ca, san));
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** A fresh self-signed certificate for `localhost` / 127.0.0.1, usable as its own CA. */
export function selfSignedCert(commonName = "localhost"): TestCert {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const alg = seq(oid(ECDSA_SHA256));
  const name = seq(tlv(0x31, seq(oid(COMMON_NAME), tlv(0x0c, Buffer.from(commonName)))));
  const now = Date.now();
  const validity = seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 3_600_000)));
  const serial = tlv(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(8)]));
  const spki = publicKey.export({ format: "der", type: "spki" });
  const version = tlv(0xa0, tlv(0x02, Buffer.from([2])));
  const tbs = seq(version, serial, alg, name, validity, name, spki, extensions());
  const signature = tlv(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey));
  const key = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { cert: pem("CERTIFICATE", seq(tbs, alg, signature)), key };
}
