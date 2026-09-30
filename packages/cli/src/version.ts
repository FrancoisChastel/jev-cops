import manifest from "../package.json" with { type: "json" };

/**
 * The CLI version; follows the workspace. In its own module so commands can read it
 * without importing `main.ts`. `cops install claude-code` refuses a hook binary whose
 * `--version` differs (the adapter's `HOOK_VERSION`; a test keeps them equal).
 */
export const CLI_VERSION: string = manifest.version;
