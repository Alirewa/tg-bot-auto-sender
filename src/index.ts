import config from './utils/config';
import logger from './utils/logger';
import { getDb, closeDb } from './database';
import { queue } from './scheduler/queue';
import { startScheduler, stopScheduler } from './scheduler';
import { createBot } from './bot';
import { Telegraf } from 'telegraf';
import { getPublishChannel } from './bot/publisher';

/**
 * Verifies the bot can post to the configured publish channel.
 * Logs a clear error and disables auto_send if the bot is not an admin.
 * Never throws — a misconfigured channel should not crash the process.
 */
async function verifyChannelAccess(bot: Telegraf): Promise<void> {
  const channel = getPublishChannel();
  if (!channel) {
    logger.warn(
      'boot: no publish channel configured. ' +
        'Send /setchannel @yourchannel to the bot to set it.',
    );
    return;
  }
  try {
    const chat = await bot.telegram.getChat(channel);
    const botInfo = await bot.telegram.getMe();
    const member = await bot.telegram.getChatMember(channel, botInfo.id);
    const isAdmin = member.status === 'administrator' || member.status === 'creator';
    if (isAdmin) {
      logger.info('boot: channel access OK', {
        channel,
        chatTitle: 'title' in chat ? chat.title : channel,
      });
    } else {
      logger.warn(
        'boot: bot is in the channel but NOT an admin — publishing will fail. ' +
          'Make the bot an admin with "Post Messages" permission.',
        { channel, status: member.status },
      );
    }
  } catch (err) {
    logger.error('boot: cannot access publish channel — check channel ID and bot membership.', {
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  logger.info('boot: starting tg-bot-auto-sender', {
    publishChannel: config.publishChannel,
    adminUserId: config.adminUserId,
    githubEnabled: !!config.githubToken,
    subsDir: config.subsDir,
  });

  // 1. Database
  getDb();

  // 2. Restore queue from previous run.
  queue.loadFromDb();

  // 3. Bot
  const bot = createBot();
  await bot.launch();
  logger.info('boot: telegraf launched');

  // 4. Verify channel access (non-blocking check, just logs)
  await verifyChannelAccess(bot);

  // 5. Scheduler
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
