import { DEFAULT_DAEMON_CONFIG, loadConfig } from "@jevdict/daemon";

/**
 * The audit log and socket paths from `jevdict.toml` (same precedence as `jevdictd`),
 * falling back to the defaults when no config can be loaded; the CLI never needs the
 * daemon to be running to read the audit log.
 */
export function configuredPaths(): { audit: string; socket: string } {
  try {
    const { config } = loadConfig();
    return { audit: config.audit.path, socket: config.daemon.socket };
  } catch {
    return { audit: DEFAULT_DAEMON_CONFIG.audit.path, socket: DEFAULT_DAEMON_CONFIG.daemon.socket };
  }
}
