#!/usr/bin/env bun
/**
 * `cops`, as the `jev-cops` package installs it: the `@jev-cops/cli` main, with the SDK
 * registered first so policies loaded from any directory import this install's copy.
 */
import { main } from "@jev-cops/cli/main";
import { registerSdkModule } from "@jev-cops/sdk/register";

registerSdkModule();
process.exit(await main(process.argv.slice(2)));
