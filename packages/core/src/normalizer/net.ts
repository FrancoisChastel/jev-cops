import {
  hasOption,
  optionValue,
  type ParsedArgs,
  type ParsedOption,
  parseArgs,
} from "./options.ts";
import { NET_METHODS, type NetMethod, type PathAccess, type PathArg } from "./types.ts";

const SCHEME_URL = /^(?:--?[A-Za-z0-9-]+=)?([A-Za-z][A-Za-z0-9+.-]*:\/\/\S+)$/;
const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const SCP_TARGET = /^(?:[^@/:\s]+@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):/;

function normalizeHost(host: string): string | null {
  const bare = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return bare === "" ? null : bare;
}

/** The host of `scheme://host/…`, also after `--opt=`; null for `file:` and non-URLs. */
export function urlHost(arg: string): string | null {
  const match = SCHEME_URL.exec(arg);
  if (match?.[1] === undefined) return null;
  try {
    const url = new URL(match[1]);
    return url.protocol === "file:" ? null : normalizeHost(url.hostname);
  } catch {
    return null;
  }
}

/** The host of `[user@]host`, `host`, or an IP literal; null when not host-shaped. */
export function bareHost(arg: string): string | null {
  const host = arg.slice(arg.lastIndexOf("@") + 1);
  if (/^\[[0-9A-Fa-f:.]+\]$/.test(host) || HOSTNAME.test(host)) return normalizeHost(host);
  return null;
}

/** The host of an scp/rsync/git remote `[user@]host:path`; null otherwise. */
export function scpHost(arg: string): string | null {
  if (arg.includes("://")) return urlHost(arg);
  const match = SCP_TARGET.exec(arg);
  return match?.[1] === undefined ? null : normalizeHost(match[1]);
}

/** A curl/wget target without scheme (`example.com/x`): host needs a dot or is localhost. */
export function webHost(arg: string): string | null {
  const fromUrl = urlHost(arg);
  if (fromUrl !== null || /^[-@./~]/.test(arg)) return fromUrl;
  try {
    const host = new URL(`http://${arg}`).hostname;
    return host.includes(".") || host === "localhost" ? normalizeHost(host) : null;
  } catch {
    return null;
  }
}

/** Method, hosts and file arguments of one curl or wget invocation. */
export interface WebReading {
  method: NetMethod;
  hosts: string[];
  paths: PathArg[];
}

const CURL_DATA = ["-d", "--data", "--data-ascii", "--data-binary", "--json"];
const CURL_FORM = ["-F", "--form"];
const CURL_UPLOAD = ["-T", "--upload-file"];
const CURL_BODY = [...CURL_DATA, "--data-raw", "--data-urlencode", ...CURL_FORM, "--form-string"];
const CURL_WRITES = ["-o", "--output", "-D", "--dump-header", "-c", "--cookie-jar"];
const CURL_READS = ["-K", "--config"];
const CURL_VALUE_OPTS = new Set([
  ...CURL_BODY,
  ...CURL_UPLOAD,
  ...CURL_WRITES,
  ...CURL_READS,
  ...["-X", "--request", "-H", "--header", "-u", "--user", "-A", "--user-agent", "-e"],
  ...["--referer", "-b", "--cookie", "-x", "--proxy", "-m", "--max-time", "-w", "--write-out"],
  ...["-r", "--range", "--retry", "-E", "--cert", "--key", "--cacert", "--resolve", "--url"],
  ...["--connect-timeout", "--connect-to", "-U", "--proxy-user", "-C", "--continue-at", "-Y"],
  ...[
    "-y",
    "-z",
    "--limit-rate",
    "--max-filesize",
    "--interface",
    "--local-port",
    "--oauth2-bearer",
  ],
]);

function toMethod(value: string): NetMethod {
  const upper = value.toUpperCase();
  return (NET_METHODS as ReadonlyArray<string>).includes(upper) ? (upper as NetMethod) : "OTHER";
}

function curlMethod(parsed: ParsedArgs): NetMethod {
  const explicit = optionValue(parsed, ["-X", "--request"]);
  if (explicit !== null) return toMethod(explicit);
  if (hasOption(parsed, ["-G", "--get"])) return "GET";
  if (hasOption(parsed, CURL_UPLOAD)) return "PUT";
  if (hasOption(parsed, CURL_BODY)) return "POST";
  return hasOption(parsed, ["-I", "--head"]) ? "OTHER" : "GET";
}

function fileOf(option: ParsedOption): { file: string; access: PathAccess } | null {
  const value = option.value ?? "";
  if (value === "" || value === "-") return null;
  if (CURL_DATA.includes(option.name)) {
    return value.startsWith("@") && value !== "@-"
      ? { file: value.slice(1), access: "read" }
      : null;
  }
  if (CURL_FORM.includes(option.name)) {
    const match = /=[@<]([^;]+)/.exec(value);
    return match?.[1] === undefined ? null : { file: match[1], access: "read" };
  }
  if (CURL_UPLOAD.includes(option.name) || CURL_READS.includes(option.name)) {
    return { file: value, access: "read" };
  }
  return CURL_WRITES.includes(option.name) ? { file: value, access: "write" } : null;
}

function optionPaths(
  parsed: ParsedArgs,
  base: number,
  fileFor: (o: ParsedOption) => { file: string; access: PathAccess } | null,
): PathArg[] {
  return parsed.options.flatMap((o) => {
    const found = fileFor(o);
    return found === null
      ? []
      : [{ value: found.file, index: base + o.index, access: found.access }];
  });
}

function hostsOf(parsed: ParsedArgs, urlOptions: ReadonlyArray<string>): string[] {
  const fromOptions = parsed.options
    .filter((o) => urlOptions.includes(o.name) && o.value !== null)
    .map((o) => webHost(o.value ?? ""));
  const fromArgs = parsed.positionals.map((p) => webHost(p.value));
  return [...fromArgs, ...fromOptions].filter((h): h is string => h !== null);
}

/** Reads a curl argv tail (`args` = argv after the name, `base` = its argv offset). */
export function readCurl(args: ReadonlyArray<string>, base: number): WebReading {
  const parsed = parseArgs(args, CURL_VALUE_OPTS);
  return {
    method: curlMethod(parsed),
    hosts: hostsOf(parsed, ["--url"]),
    paths: optionPaths(parsed, base, fileOf),
  };
}

const WGET_WRITES = ["-O", "--output-document", "-o", "--output-file", "-a", "--append-output"];
const WGET_DIRS = ["-P", "--directory-prefix"];
const WGET_READS = ["-i", "--input-file", "--post-file", "--body-file"];
const WGET_VALUE_OPTS = new Set([
  ...WGET_WRITES,
  ...WGET_DIRS,
  ...WGET_READS,
  ...["--post-data", "--body-data", "--method", "--header", "--user", "--password", "-U"],
  ...["--user-agent", "-t", "--tries", "-T", "--timeout", "-w", "--wait", "-e", "--execute"],
]);

function wgetFile(option: ParsedOption): { file: string; access: PathAccess } | null {
  const value = option.value ?? "";
  if (value === "" || value === "-") return null;
  if (WGET_READS.includes(option.name)) return { file: value, access: "read" };
  const writes = WGET_WRITES.includes(option.name) || WGET_DIRS.includes(option.name);
  return writes ? { file: value, access: "write" } : null;
}

/** Reads a wget argv tail (`args` = argv after the name, `base` = its argv offset). */
export function readWget(args: ReadonlyArray<string>, base: number): WebReading {
  const parsed = parseArgs(args, WGET_VALUE_OPTS);
  const explicit = optionValue(parsed, ["--method"]);
  const posts = hasOption(parsed, ["--post-data", "--post-file"]);
  return {
    method: explicit !== null ? toMethod(explicit) : posts ? "POST" : "GET",
    hosts: hostsOf(parsed, []),
    paths: optionPaths(parsed, base, wgetFile),
  };
}

const SSH_VALUE_OPTS = new Set(
  ["-p", "-i", "-l", "-o", "-F", "-J", "-b", "-c", "-D", "-E", "-e", "-I", "-L", "-m"].concat([
    "-O",
    "-Q",
    "-R",
    "-S",
    "-W",
    "-w",
    "-B",
    "-P",
  ]),
);
const NC_VALUE_OPTS = new Set(["-p", "-s", "-w", "-i", "-x", "-X", "-q", "-e", "-c", "-I", "-O"]);
const RSYNC_VALUE_OPTS = new Set(["-e", "--rsh", "--exclude", "--include", "-f", "--filter"]);

function firstPositional(args: ReadonlyArray<string>, valueOpts: ReadonlySet<string>): string[] {
  const first = parseArgs(args, valueOpts).positionals[0];
  return first === undefined ? [] : [first.value];
}

function registryHost(image: string): string | null {
  const head = image.split("/")[0] ?? "";
  if (!image.includes("/") || !(head.includes(".") || head.includes(":") || head === "localhost")) {
    return null;
  }
  return bareHost(head.replace(/:\d+$/, ""));
}

function dockerHosts(args: ReadonlyArray<string>): string[] {
  const parsed = parseArgs(args, new Set(["-H", "--host", "--config", "--context", "-c"]), true);
  const daemon = optionValue(parsed, ["-H", "--host"]);
  const [sub, image] = parsed.positionals.map((p) => p.value);
  const daemonHost = daemon === null ? null : (urlHost(daemon) ?? bareHost(daemon));
  const imageHost = (sub === "push" || sub === "pull") && image ? registryHost(image) : null;
  return [daemonHost, imageHost].filter((h): h is string => h !== null);
}

/**
 * Hosts named by the non-URL arguments of a network verb: the ssh/sftp/nc/telnet
 * destination, scp/rsync `host:path` remotes, docker `-H` and registry hosts. URL
 * arguments are handled for every command by {@link urlHost}.
 */
export function verbHosts(name: string, args: ReadonlyArray<string>): string[] {
  const found = ((): Array<string | null> => {
    switch (name) {
      case "ssh":
        return firstPositional(args, SSH_VALUE_OPTS).map(bareHost);
      case "sftp":
        return firstPositional(args, SSH_VALUE_OPTS).map((a) => scpHost(a) ?? bareHost(a));
      case "scp":
        return parseArgs(args, SSH_VALUE_OPTS).positionals.map((p) => scpHost(p.value));
      case "rsync":
        return parseArgs(args, RSYNC_VALUE_OPTS).positionals.map((p) => scpHost(p.value));
      case "nc":
      case "ncat":
      case "telnet":
      case "ftp":
        return firstPositional(args, NC_VALUE_OPTS).map(bareHost);
      case "docker":
        return dockerHosts(args);
      default:
        return [];
    }
  })();
  return found.filter((h): h is string => h !== null);
}
