import { Telegraf } from 'telegraf';
import config from '../utils/config';
import logger from '../utils/logger';
import { htmlEscape } from '../utils/escape';
import { ValidatedConfig } from '../types';
import { sleep } from '../utils/retry';
import { SettingsRepo } from '../database/repositories';
import { renameConfig } from '../utils/renamer';

// Maximum config length before truncation (Telegram message limit = 4096 chars).
const MAX_CONFIG_LENGTH = 3800;

interface TelegramApiError extends Error {
  response?: {
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  };
}

/**
 * Classifies a Telegram API error into one of three categories:
 *  - 'flood'       → 429, honour retry_after
 *  - 'permanent'   → 400/401/403/404, never retry
 *  - 'transient'   → network errors, 5xx, etc. — retry with backoff
 */
function classifyError(err: TelegramApiError): 'flood' | 'permanent' | 'transient' {
  const code = err.response?.error_code;
  if (!code) return 'transient';
  if (code === 429) return 'flood';
  if (code >= 400 && code < 500) return 'permanent';
  return 'transient';
}

/**
 * Builds the label injected into the config's own name field.
 * Template placeholders:
 *   {flag}     → country flag emoji
 *   {n}        → post counter (1, 2, 3, …)
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

/**
 * Builds the Telegram HTML message with an enhanced, premium-looking format.
 */
function buildMessage(c: ValidatedConfig, renamedRaw: string): string {
  // Truncate very long configs before wrapping so the message stays under 4096 chars.
  const truncated =
    renamedRaw.length > MAX_CONFIG_LENGTH ? renamedRaw.slice(0, MAX_CONFIG_LENGTH) : renamedRaw;
  const body = htmlEscape(truncated);

  const proto = c.protocol.toUpperCase();
  const country = c.country || 'Unknown';
  const ping = `${c.latencyMs}ms`;

  // Strip @ from channel handle for the hashtag, keep @ for the join line.
  const channelTag = config.publishChannelHandle.replace(/^@/, '');
  const channelHandle = config.publishChannelHandle.startsWith('@')
    ? config.publishChannelHandle
    : `@${config.publishChannelHandle}`;

  return [
    '━━━━━━━━━━━━━━━━━━━━━━━',
    `${c.flag} <b>${country}</b>  ⚡ <b>${proto}</b>`,
    `📶 Ping: <b>${ping}</b>  🟢 Online`,
    '━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `<code>${body}</code>`,
    '',
    `🔗 Join: ${channelHandle}`,
    `#config #v2ray #vpn #${channelTag} #${c.protocol}`,
  ].join('\n');
}

/**
 * Publish a single validated config to the Telegram channel.
 *
 * Returns normally on success.
 * Throws a PublishError (with a `permanent` flag) so the caller can decide
 * whether to mark the config dead or just re-queue it.
 */
export class PublishError extends Error {
  constructor(
    message: string,
    public readonly permanent: boolean,
    public readonly disableAutoSend: boolean = false,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export async function publishConfig(bot: Telegraf, c: ValidatedConfig): Promise<void> {
  const template = SettingsRepo.getString('template', '{flag} - #{n} {channel}');
  const n = SettingsRepo.incrementInt('post_counter', 1);
  const label = renderLabel(template, c, n);
  const renamed = renameConfig(c.protocol, c.raw, label);
  const text = buildMessage(c, renamed);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await bot.telegram.sendMessage(config.publishChannel, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return; // success
    } catch (err) {
      const tgErr = err as TelegramApiError;
      const kind = classifyError(tgErr);
      const errorCode = tgErr.response?.error_code;
      const description = tgErr.response?.description ?? tgErr.message;

      if (kind === 'flood') {
        const retryAfter = tgErr.response?.parameters?.retry_after ?? 5;
        logger.warn('publisher: 429 flood wait', { retryAfter, attempt });
        await sleep((retryAfter + 1) * 1000);
        continue; // retry after sleeping
      }

      if (kind === 'permanent') {
        // 400 "chat not found", 403 "bot is not a member", 401 "unauthorized", etc.
        logger.error('publisher: permanent Telegram error — disabling auto_send', {
          channel: config.publishChannel,
          hash: c.hash.slice(0, 12),
          errorCode,
          description,
        });
        throw new PublishError(
          `Telegram ${errorCode}: ${description}`,
          true,  // permanent
          true,  // disableAutoSend
        );
      }

      // Transient (network, 5xx, etc.)
      logger.warn('publisher: transient error', { attempt, errorCode, description });
      if (attempt === 3) {
        throw new PublishError(`Transient send failure: ${description}`, false, false);
      }
      await sleep(1500 * attempt);
    }
  }
}
