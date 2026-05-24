import config from './utils/config';
import logger from './utils/logger';
import { getDb, closeDb } from './database';
import { queue } from './scheduler/queue';
import { startScheduler, stopScheduler } from './scheduler';
import { createBot } from './bot';

async function main(): Promise<void> {
  logger.info('boot: starting tg-bot-auto-sender', {
    publishChannel: config.publishChannel,
    adminUserId: config.adminUserId,
  });

  // 1. Database
  getDb();

  // 2. Restore queue from previous run.
  queue.loadFromDb();

  // 3. Bot
  const bot = createBot();
  await bot.launch();
  logger.info('boot: telegraf launched');

  // 4. Scheduler
  startScheduler(bot);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutdown: signal received', { signal });
    try {
      stopScheduler();
      bot.stop(signal);
      closeDb();
    } catch (err) {
      logger.error('shutdown: error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Give logger a tick to flush.
      setTimeout(() => process.exit(0), 300);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('boot: fatal', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
