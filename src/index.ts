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
import * as https from 'https';
import * as dns from 'dns';

// ---------------------------------------------------------------------------
// Hang-detection helpers
// ---------------------------------------------------------------------------

/**
 * Wraps a promise with a hard timeout. Rejects with a descriptive error if
 * the operation does not complete within `ms` milliseconds.
 */
function withTimeout<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TIMEOUT after ${ms}ms: ${label}`));
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Low-level TCP/TLS connectivity probe for api.telegram.org:443.
 * Tells us whether the hang is at DNS or at the TCP layer.
 */
async function probeConnectivity(): Promise<void> {
  const host = 'api.telegram.org';

  // --- Step 1: DNS ---
  logger.info('connectivity: resolving ' + host + ' …');
  let addrs: string[] = [];
  try {
    addrs = await withTimeout(
      'dns.resolve4(' + host + ')',
      8_000,
      new Promise<string[]>((res, rej) =>
        dns.resolve4(host, (err, a) => (err ? rej(err) : res(a))),
      ),
    );
    logger.info('connectivity: DNS OK (IPv4)', { addrs });
  } catch (e) {
    logger.error('connectivity: DNS resolve4 FAILED', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // Also try IPv6 — just to see what the OS returns.
  try {
    const addrs6 = await withTimeout(
      'dns.resolve6(' + host + ')',
      8_000,
      new Promise<string[]>((res, rej) =>
        dns.resolve6(host, (err, a) => (err ? rej(err) : res(a))),
      ),
    );
    logger.info('connectivity: DNS OK (IPv6)', { addrs: addrs6 });
  } catch (e) {
    logger.warn('connectivity: DNS resolve6 failed (expected if IPv6 unavailable)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // --- Step 2: HTTPS GET ---
  const target = 'https://' + host + '/';
  logger.info('connectivity: HTTPS GET ' + target + ' …');
  try {
    await withTimeout(
      'https.get ' + target,
      10_000,
      new Promise<void>((res, rej) => {
        const req = https.get(target, { timeout: 8_000 }, (r) => {
          logger.info('connectivity: HTTPS OK', { statusCode: r.statusCode });
          r.resume(); // drain
          res();
        });
        req.on('error', rej);
        req.on('timeout', () => { req.destroy(); rej(new Error('socket timeout')); });
      }),
    );
  } catch (e) {
    logger.error('connectivity: HTTPS GET FAILED — this is why bot.launch() hangs', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---------------------------------------------------------------------------
// Channel access verification (non-blocking, just logs)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('boot: starting tg-bot-auto-sender', {
    publishChannel: config.publishChannel,
    adminUserId: config.adminUserId,
    githubEnabled: !!config.githubToken,
    subsDir: config.subsDir,
  });

  // 0. Network sanity check — runs BEFORE bot.launch() so the journal
  //    clearly shows what blocks if launch hangs.
  logger.info('boot: probing connectivity to api.telegram.org …');
  await probeConnectivity();
  logger.info('boot: connectivity probe complete');

  // 1. Database
  logger.info('boot: opening database …');
  getDb();
  logger.info('boot: database ready');

  // 2. Restore queue from previous run.
  logger.info('boot: restoring queue from DB …');
  queue.loadFromDb();
  logger.info('boot: queue restored', { size: queue.size() });

  // 3. Bot
  logger.info('boot: creating Telegraf instance …');
  const bot = createBot();

  logger.info('boot: calling bot.telegram.getMe() to verify token …');
  try {
    const me = await withTimeout('bot.telegram.getMe()', 15_000, bot.telegram.getMe());
    logger.info('boot: token OK', { botUsername: me.username, botId: me.id });
  } catch (err) {
    logger.error('boot: getMe() FAILED — token may be invalid or Telegram is unreachable', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Do not abort: let launch() surface its own error too.
  }

  logger.info(
    'boot: launching Telegraf (dropPendingUpdates=true — clears stale polling lock from old instances)',
  );
  try {
    await withTimeout('bot.launch()', 30_000, bot.launch({ dropPendingUpdates: true }));
  } catch (err) {
    logger.error('boot: bot.launch() FAILED or timed out', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
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
