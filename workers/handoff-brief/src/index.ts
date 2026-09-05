/**
 * Worker entrypoint.
 *
 * Wires the Postgres and Redis adapters to the generator and starts consuming.
 * Run with `npm -w @handoff/worker-handoff-brief run dev`.
 */

import { Pool } from 'pg';
import Redis from 'ioredis';

import { PgBriefStore, PgContextLoader, RedisBriefNotifier } from './adapters';
import {
  BriefGenerator,
  consoleLogger,
  createAnthropicClient,
  createQueue,
  loadConfig,
  startWorker,
} from './worker';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail at boot rather than on the first job: a worker that starts and then
    // fails every job is harder to diagnose than one that refuses to start.
    throw new Error(`${name} must be set to run the handoff-brief worker.`);
  }
  return value;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: required('DATABASE_URL') });
  const redisUrl = required('REDIS_URL');
  const publisher = new Redis(redisUrl);

  const generator = new BriefGenerator(
    {
      anthropic: createAnthropicClient(),
      loader: new PgContextLoader(pool, consoleLogger),
      store: new PgBriefStore(pool),
      notifier: new RedisBriefNotifier(publisher, consoleLogger),
      logger: consoleLogger,
    },
    config,
  );

  const queue = startWorker({
    generator,
    notifier: new RedisBriefNotifier(publisher, consoleLogger),
    queue: createQueue(redisUrl),
    logger: consoleLogger,
    config,
  });

  const shutdown = async (signal: string): Promise<void> => {
    consoleLogger.info(`${signal} received; draining`);
    // Let in-flight jobs finish before closing their dependencies.
    await queue.close();
    await Promise.allSettled([pool.end(), publisher.quit()]);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  consoleLogger.error('worker failed to start', err);
  process.exit(1);
});
