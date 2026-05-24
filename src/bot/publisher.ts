import { Telegraf } from 'telegraf';
import config from '../utils/config';
import logger from '../utils/logger';
import { htmlEscape } from '../utils/escape';
import { ValidatedConfig } from '../types';
import { sleep } from '../utils/retry';
import { SettingsRepo } from '../database/repositories';
import { renameConfig } from '../utils/renamer';

const HASHTAGS = '#کانفیگ #اینترنت #فیلترشکن #v2ray #config';

interface TelegramApiError extends Error {
  response?: {
    error_code?: number;
    parameters?: { retry_after?: number };
  };
}

/**
 * Builds the label injected into the config's own name field.
 * Template placeholders supported:
 *   {flag}     → country flag emoji
 *   {n}        → post counter (1, 2, 3, ...)
 *   {channel}  → publishChannel handle e.g. @webdw
 *   {country}  → 2-letter country code
 */
function renderLabel(template: string, c: ValidatedConfig, n: number): string {
  return template
    .replace(/\{flag\}/g, c.flag)
    .replace(/\{n\}/g, String(n))
    .replace(/\{channel\}/g, config.publishChannelHandle)
    .replace(/\{country\}/g, c.country);
}

function buildMessage(renamedRaw: string): string {
  const body = htmlEscape(renamedRaw);
  return `<code>${body}</code>\n\n${HASHTAGS}`;
}

export async function publishConfig(bot: Telegraf, c: ValidatedConfig): Promise<void> {
  const template = SettingsRepo.getString('template', '{flag} - #{n} {channel}');
  const n = SettingsRepo.incrementInt('post_counter', 1);
  const label = renderLabel(template, c, n);
  const renamed = renameConfig(c.protocol, c.raw, label);
  const text = buildMessage(renamed);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await bot.telegram.sendMessage(config.publishChannel, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return;
    } catch (err) {
      const tgErr = err as TelegramApiError;
      const retryAfter = tgErr.response?.parameters?.retry_after;
      if (retryAfter && attempt < 3) {
        logger.warn('publisher: 429 flood, sleeping', { retryAfter, attempt });
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      if (attempt === 3) throw err;
      await sleep(1500 * attempt);
    }
  }
}
