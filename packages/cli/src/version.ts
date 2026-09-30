/**
 * The CLI version; follows the workspace. `cops install claude-code` refuses a hook binary
 * whose `--version` differs (the adapter's `HOOK_VERSION`; a test keeps them equal).
 */
export const CLI_VERSION = "0.0.0";
