#!/usr/bin/env bun
/**
 * `copsd`, as the `jev-cops` package installs it: the `@jev-cops/daemon` main, with the
 * SDK registered first so policies loaded from any directory import this install's copy.
 */
import { main } from "@jev-cops/daemon/main";
import { registerSdkModule } from "@jev-cops/sdk/register";

registerSdkModule();
process.exit(await main(process.argv.slice(2)));
