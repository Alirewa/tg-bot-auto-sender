import { Telegraf } from 'telegraf';
import config from '../utils/config';
import logger from '../utils/logger';
import { adminGate } from './middleware';
import { registerCommands } from './commands';

export function createBot(): Telegraf {
  const bot = new Telegraf(config.botToken, {
    handlerTimeout: 30_000,
  });

  bot.use(async (ctx, next) => {
    const start = Date.now();
    try {
      await next();
    } finally {
      logger.debug('update handled', {
        type: ctx.updateType,
        ms: Date.now() - start,
      });
    }
  });

  // Single global gate: only the configured admin user can talk to the bot.
  bot.use(adminGate);

  registerCommands(bot);

  return bot;
}
