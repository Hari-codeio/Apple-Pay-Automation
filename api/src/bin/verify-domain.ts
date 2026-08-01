import 'reflect-metadata';
import { writeSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DomainVerificationService } from '../domain-verification/domain-verification.service';
import { createBootstrapLogger } from '../observability/app-logger';

/**
 * Run the verification flow from the command line:
 *
 *   pnpm apple:verify pay.example.com
 *   pnpm apple:verify pay.example.com --store-code 1042
 *   pnpm apple:verify pay.example.com --skip-verify
 *
 * Same code path as `POST /api/domain-verifications` — this boots the real
 * container, so config validation, logging, and the database write are identical.
 * It exists because the first run of a new domain is usually done by a person
 * watching the output, not by a caller with an API key.
 */
interface CliArgs {
  domain: string;
  storeCode: number | null;
  skipVerify: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let storeCode: number | null = null;
  let skipVerify = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-verify') {
      skipVerify = true;
    } else if (arg === '--store-code') {
      const raw = argv[i + 1];
      i += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(
          `--store-code expects a positive integer (got '${raw}')`,
        );
      }
      storeCode = parsed;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown flag '${arg}'`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new Error(
      'Usage: pnpm apple:verify <domain> [--store-code <n>] [--skip-verify]',
    );
  }
  return { domain: positional[0], storeCode, skipVerify };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // An application context, not an HTTP server: no port is bound, but every
  // provider and lifecycle hook runs exactly as it does in the service.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: createBootstrapLogger(),
  });
  app.enableShutdownHooks();

  try {
    const service = app.get(DomainVerificationService);
    const result = await service.register({
      domain: args.domain,
      storeCode: args.storeCode,
      skipVerify: args.skipVerify,
    });
    // writeSync, not process.stdout.write: the explicit exit below can truncate
    // an async write to a pipe on Windows, and this summary is the whole output.
    writeSync(1, `\n${JSON.stringify(result, null, 2)}\n\n`);
  } finally {
    // Closes the MySQL pool. Without this the process hangs on an idle
    // connection instead of exiting.
    await app.close();
  }
}

/**
 * Exit explicitly.
 *
 * In CDP mode the factory deliberately never calls `browser.close()` — that would
 * terminate the operator's browser and destroy the Apple session, which is
 * memory-only. But the open CDP connection is an active libuv handle, so Node
 * keeps running after all the work is done and the CLI hangs forever. Ending the
 * process is what drops the connection; the browser stays up, which is exactly
 * what we want. Same reasoning as google-pay-automation's runner, which exits
 * rather than closing an attached Chrome.
 */
main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      '\napple:verify failed:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
