// Node.js 18+ prefers IPv6 by default. Many servers (incl. Hetzner) have
// broken IPv6 routes to api.telegram.org — this causes bot.launch() to hang
// indefinitely. Force IPv4 DNS order to match curl's behaviour.
import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first');

import config from './utils/config';
import logger from './utils/logger';
import { getDb, closeDb } from './database';
import { queue } from './scheduler/queue';
import { startScheduler, stopScheduler } from './scheduler';
import { createBot } from './bot';
import { Telegraf } from 'telegraf';
import { getPublishChannel } from './bot/publisher';
import { SettingsRepo } from './database/repositories';

// ---------------------------------------------------------------------------
// Channel access check — non-blocking, just logs
// ---------------------------------------------------------------------------

async function verifyChannelAccess(bot: Telegraf): Promise<void> {
  const channel = getPublishChannel();
  if (!channel) {
    logger.error(
      '=== CHANNEL NOT CONFIGURED ===' +
        ' The bot will NOT post anything until you set a channel.' +
        ' Send /setchannel @your_channel to the bot, or set PUBLISH_CHANNEL in .env',
    );
    return;
  }
  try {
    const chat = await bot.telegram.getChat(channel);
    const botInfo = await bot.telegram.getMe();
    const member = await bot.telegram.getChatMember(channel, botInfo.id);
    const isAdmin = member.status === 'administrator' || member.status === 'creator';
    if (isAdmin) {
      logger.info('channel check: OK — bot is admin', {
        channel,
        chatTitle: 'title' in chat ? chat.title : channel,
      });
    } else {
      logger.error(
        '=== BOT IS NOT CHANNEL ADMIN ===' +
          ' The bot will fail to post.' +
          ' Go to channel > Admins > add the bot with "Post Messages" permission.',
        { channel, status: member.status },
      );
    }
  } catch (err) {
    logger.error('channel check: FAILED — wrong channel ID or bot not a member', {
      channel,
      error: err instanceof Error ? err.message : String(err),
      hint: 'Make sure the bot is a member/admin of the channel and the channel ID is correct',
    });
  }
}

// ---------------------------------------------------------------------------
// Startup status summary
// ---------------------------------------------------------------------------

function logStartupStatus(): void {
  const channel = getPublishChannel();
  const autoSend = SettingsRepo.getBool('auto_send', true);
  const queueSize = queue.size();
  const template = SettingsRepo.getString('template', '');

  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('STARTUP STATUS', {
    channel: channel || '❌ NOT SET (bot will not post!)',
    autoSend: autoSend ? '✅ ON' : '❌ OFF (send /on to re-enable)',
    queueSize,
    template,
  });
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!channel) {
    logger.error('ACTION REQUIRED: Set PUBLISH_CHANNEL in .env OR send /setchannel @channel to the bot');
  }
  if (!autoSend) {
    logger.error('ACTION REQUIRED: auto_send is OFF — send /on to the bot to re-enable');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('boot: starting tg-bot-auto-sender', {
    publishChannel: config.publishChannel || '(not set in .env — can be set via /setchannel)',
    adminUserId: config.adminUserId,
    githubEnabled: !!config.githubToken,
    subsDir: config.subsDir,
    publishCron: config.publishCron,
    scrapeCron: config.scrapeCron,
  });

  // 1. Database
  logger.info('boot: opening database …');
  getDb();
  logger.info('boot: database ready');

  // 2. Restore queue
  logger.info('boot: restoring queue from DB …');
  queue.loadFromDb();
  logger.info('boot: queue restored', { size: queue.size() });

  // 3. Create bot instance
  logger.info('boot: creating Telegraf instance …');
  const bot = createBot();

  // 4. Verify token — fast sanity check before anything else.
  logger.info('boot: verifying bot token (getMe) …');
  try {
    const me = await bot.telegram.getMe();
    logger.info('boot: token OK', { botUsername: me.username, botId: me.id });
  } catch (err) {
    // Token invalid or Telegram unreachable — fatal.
    throw new Error(
      'bot.telegram.getMe() failed: ' + (err instanceof Error ? err.message : String(err)) +
      '\nCheck BOT_TOKEN in .env and network connectivity to api.telegram.org',
    );
  }

  // 5. Launch polling loop.
  //
  //    IMPORTANT: In Telegraf v4, bot.launch() returns a Promise that only
  //    resolves when bot.stop() is called (it represents the lifetime of the
  //    polling loop, not just startup).  We must NOT await it here — doing so
  //    would block the process forever (or until a 30-second timeout kills it).
  //
  //    Outgoing messages (bot.telegram.sendMessage) work immediately after the
  //    token is verified — they do not depend on the polling loop being ready.
  //
  logger.info('boot: starting Telegraf polling (fire-and-forget) …');
  const launchDone = { resolved: false };
  const launchPromise = bot.launch({ dropPendingUpdates: true });

  launchPromise
    .then(() => {
      launchDone.resolved = true;
      logger.info('bot: polling loop ended (bot.stop() was called)');
    })
    .catch((err) => {
      launchDone.resolved = true;
      logger.error('bot: polling loop crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // Give Telegraf ~3 seconds to call deleteWebhook so stale updates are
  // dropped before the scheduler starts processing the queue.
  logger.info('boot: waiting 3s for Telegraf initialization …');
  await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
  logger.info('boot: Telegraf ready');

  // 6. Channel access check (logs warnings, never throws).
  logger.info('boot: checking channel access …');
  await verifyChannelAccess(bot);

  // 7. Log startup status — the single most useful thing for debugging.
  logStartupStatus();

  // 8. Scheduler (also fires an immediate scrape cycle on its own).
  startScheduler(bot);

  // 9. Notify admin via DM that the bot has (re)started.
  //    Best-effort: if this fails (DM not open), just log and continue.
  bot.telegram
    .sendMessage(
      config.adminUserId,
      `🤖 <b>Bot started</b>\n\n` +
        `Channel: <code>${getPublishChannel() || '(not configured)'}</code>\n` +
        `Queue: <b>${queue.size()}</b> configs\n` +
        `Auto-send: <b>${SettingsRepo.getBool('auto_send', true) ? 'ON ✅' : 'OFF ❌'}</b>\n\n` +
        (getPublishChannel()
          ? '✅ Bot is running and will post every minute.'
          : '⚠️ No channel set — use /setchannel @your_channel'),
      { parse_mode: 'HTML' },
    )
    .catch((err) => {
      logger.warn('boot: could not send startup DM to admin (DM may not be open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // 10. Shutdown handlers.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutdown: signal received', { signal });
    try {
      stopScheduler();
      bot.stop(signal); // resolves launchPromise
      closeDb();
    } catch (err) {
      logger.error('shutdown: error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTimeout(() => process.exit(0), 300);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('boot: fatal — process will exit', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
