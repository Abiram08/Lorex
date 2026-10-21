#!/usr/bin/env node
/** Executable entry point. Loads .env and dispatches to the CLI. */

import { hydrateEnvFromDotEnv } from "./infrastructure/config.js";
import { runCli } from "./interfaces/cli.js";

function fail(prefix: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`lorex: ${prefix} ${message}\n`);
  process.exit(1);
}

process.on("unhandledRejection", (reason) => fail("unhandled rejection —", reason));
process.on("uncaughtException", (error) => fail("fatal —", error));

hydrateEnvFromDotEnv();

runCli(process.argv.slice(2)).catch((error) => fail("", error));
