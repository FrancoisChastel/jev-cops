import manifest from "../package.json" with { type: "json" };

/**
 * The jev-cops version the hook reports (`cops-hook --version`). `cops install` and
 * `cops doctor` refuse a hook binary whose version differs from the CLI's (`CLI_VERSION`,
 * kept equal by a CLI test): a stale binary may map verdicts differently.
 */
export const HOOK_VERSION: string = manifest.version;
