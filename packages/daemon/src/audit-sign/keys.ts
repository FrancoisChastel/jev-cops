import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * The audit signing key (D-104): Ed25519, the private key in PKCS #8 PEM at `[audit] key`
 * (default `~/.jev-cops/keys/audit-ed25519.key`, 0600 in a 0700 directory, a private path
 * of the daemon and outside any sandbox), the public key in SPKI PEM at `[audit]
 * public_key` for the cyber team. A key id is the first 16 hex characters of the SHA-256
 * of the raw 32-byte public key. No dependency: `node:crypto` has Ed25519.
 */

/** What signs checkpoint statements; the daemon holds one, never the agent. */
export interface CheckpointSigner {
  readonly keyId: string;
  readonly publicKeyPem: string;
  /** The base64url Ed25519 signature of `message`. */
  sign(message: Buffer): string;
}

/** A public key a verifier trusts, with its id. */
export interface PublicKeyInfo {
  readonly keyId: string;
  readonly pem: string;
  readonly key: KeyObject;
}

/** A freshly generated key pair. */
export interface AuditKeyPair {
  readonly keyId: string;
  readonly privatePem: string;
  readonly publicPem: string;
}

/** A key that could not be used, and whether it was simply absent. */
export type KeyLoad<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly missing: boolean; readonly error: string };

const RAW_KEY_BYTES = 32;

function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" });
  const raw = Buffer.from(jwk.x ?? "", "base64url");
  if (key.asymmetricKeyType !== "ed25519" || raw.length !== RAW_KEY_BYTES) {
    throw new Error("not an Ed25519 key");
  }
  return raw;
}

/** The key id of a public key (PEM or key object). */
export function keyIdOf(publicKey: string | KeyObject): string {
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  return createHash("sha256").update(rawPublicKey(key)).digest("hex").slice(0, 16);
}

/** A new Ed25519 key pair. */
export function generateAuditKey(): AuditKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return { keyId: keyIdOf(publicKey), privatePem, publicPem };
}

/** A signer over a PKCS #8 PEM private key; throws when it is not Ed25519. */
export function signerFromPem(pem: string): CheckpointSigner {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 private key");
  const publicKey = createPublicKey(key);
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return {
    keyId: keyIdOf(publicKey),
    publicKeyPem,
    sign: (message) => sign(null, message, key).toString("base64url"),
  };
}

/** A trusted public key from SPKI PEM; throws when it is not Ed25519. */
export function publicKeyFromPem(pem: string): PublicKeyInfo {
  const key = createPublicKey(pem);
  return { keyId: keyIdOf(key), pem: key.export({ format: "pem", type: "spki" }).toString(), key };
}

function reason(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /ed25519/i.test(text) ? text : `not an Ed25519 key (${text})`;
}

/** Why a private key file must not be used: readable by others, or not the user's. */
function unsafeMode(path: string): string | null {
  const st = statSync(path);
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    const octal = mode.toString(8).padStart(4, "0");
    return `${path} has mode ${octal}: a signing key must be 0600 (chmod 600 ${path})`;
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return `${path} is not owned by this user`;
  return null;
}

/** Loads the private key at `path` as a signer; refuses a key others can read. */
export function loadSigner(path: string): KeyLoad<{ signer: CheckpointSigner }> {
  if (!existsSync(path)) {
    return { ok: false, missing: true, error: `no audit signing key at ${path}` };
  }
  try {
    const unsafe = unsafeMode(path);
    if (unsafe !== null) return { ok: false, missing: false, error: unsafe };
    return { ok: true, signer: signerFromPem(readFileSync(path, "utf8")) };
  } catch (cause) {
    return { ok: false, missing: false, error: `${path}: ${reason(cause)}` };
  }
}

/** Loads a trusted public key from an SPKI PEM file. */
export function loadPublicKey(path: string): KeyLoad<{ key: PublicKeyInfo }> {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (cause) {
    const missing = !existsSync(path);
    return { ok: false, missing, error: `cannot read ${path}: ${(cause as Error).message}` };
  }
  try {
    return { ok: true, key: publicKeyFromPem(pem) };
  } catch (cause) {
    return { ok: false, missing: false, error: `${path}: ${reason(cause)}` };
  }
}

/** Where `cops keygen --rotate` leaves the next key until copsd switches to it. */
export function pendingKeyPath(keyPath: string): string {
  return `${keyPath}.next`;
}

/** Writes a private key file 0600 (its directory 0700 when created); never overwrites. */
export function writePrivateKey(path: string, pem: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${path} exists`);
    throw cause;
  }
  try {
    writeSync(fd, pem);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Writes a public key file (0644; its directory 0700 when created). */
export function writePublicKey(path: string, pem: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, pem, { mode: 0o644 });
}

/** Writes a new pair: the private key (never over an existing one), then the public key. */
export function writeKeyPair(pair: AuditKeyPair, keyPath: string, publicPath: string): void {
  writePrivateKey(keyPath, pair.privatePem);
  writePublicKey(publicPath, pair.publicPem);
}
