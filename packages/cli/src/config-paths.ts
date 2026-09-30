import { type DaemonConfig, DEFAULT_DAEMON_CONFIG, loadConfig } from "@jev-cops/daemon";

/** The daemon paths the CLI talks to or reads. */
export interface ConfiguredPaths {
  readonly audit: string;
  /** The agent-facing socket. */
  readonly socket: string;
  /** The human-only socket (`budget --reset`). */
  readonly adminSocket: string;
}

function pathsOf(config: DaemonConfig): ConfiguredPaths {
  const { socket, adminSocket } = config.daemon;
  return { audit: config.audit.path, socket, adminSocket };
}

/**
 * The audit log and socket paths from `cops.toml` (same precedence as `copsd`),
 * falling back to the defaults when no config can be loaded; the CLI never needs the
 * daemon to be running to read the audit log.
 */
export function configuredPaths(): ConfiguredPaths {
  try {
    return pathsOf(loadConfig().config);
  } catch {
    return pathsOf(DEFAULT_DAEMON_CONFIG);
  }
}
