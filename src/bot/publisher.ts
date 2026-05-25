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

// ---------------------------------------------------------------------------
// Small-caps converter (a–z only; non-alpha chars pass through unchanged)
// ---------------------------------------------------------------------------
const SMALL_CAPS: Record<string, string> = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ',
  j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'Q', r: 'ʀ',
  s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ',
};

function toSmallCaps(text: string): string {
  return text
    .toLowerCase()
    .split('')
    .map((ch) => SMALL_CAPS[ch] ?? ch)
    .join('');
}

// Country code → full English name (most common VPN server countries)
const COUNTRY_NAMES: Record<string, string> = {
  AF: 'Afghanistan', AL: 'Albania', AM: 'Armenia', AT: 'Austria', AU: 'Australia',
  AZ: 'Azerbaijan', BA: 'Bosnia', BE: 'Belgium', BG: 'Bulgaria', BR: 'Brazil',
  BY: 'Belarus', CA: 'Canada', CH: 'Switzerland', CL: 'Chile', CN: 'China',
  CZ: 'Czechia', DE: 'Germany', DK: 'Denmark', EE: 'Estonia', ES: 'Spain',
  FI: 'Finland', FR: 'France', GB: 'UK', GE: 'Georgia', GR: 'Greece',
  HK: 'Hong Kong', HR: 'Croatia', HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland',
  IL: 'Israel', IN: 'India', IR: 'Iran', IT: 'Italy', JP: 'Japan',
  KR: 'South Korea', KZ: 'Kazakhstan', LT: 'Lithuania', LU: 'Luxembourg',
  LV: 'Latvia', MD: 'Moldova', MK: 'North Macedonia', MX: 'Mexico', MY: 'Malaysia',
  NL: 'Netherlands', NO: 'Norway', NZ: 'New Zealand', PL: 'Poland', PT: 'Portugal',
  RO: 'Romania', RS: 'Serbia', RU: 'Russia', SE: 'Sweden', SG: 'Singapore',
  SI: 'Slovenia', SK: 'Slovakia', TH: 'Thailand', TR: 'Turkey', TW: 'Taiwan',
  UA: 'Ukraine', US: 'United States', UZ: 'Uzbekistan', VN: 'Vietnam',
  ZA: 'South Africa', XX: 'Unknown',
};

/** Returns the full country name for a 2-letter ISO code, falling back to the code itself. */
function countryName(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] ?? code;
}

// ---------------------------------------------------------------------------

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
 * Returns the active publish channel — DB value takes precedence over .env
 * so the admin can change it live via /setchannel without restarting.
 */
export function getPublishChannel(): string {
  return SettingsRepo.getString('publish_channel', config.publishChannel);
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
    .replace(/\{channel\}/g, getPublishChannel())
    .replace(/\{country\}/g, c.country);
}

/**
 * Builds the Telegram message in the compact format:
 *
 *   #v2ray
 *
 *   `vless://…#[🇮🇷] @channel`
 *
 *   ᴄᴏᴜɴᴛʀʏ: #ɪʀᴀɴ(🇮🇷)  @channel
 */
function buildMessage(c: ValidatedConfig, renamedRaw: string): string {
  // Truncate very long configs so the message stays under Telegram's 4096-char limit.
  const truncated =
    renamedRaw.length > MAX_CONFIG_LENGTH ? renamedRaw.slice(0, MAX_CONFIG_LENGTH) : renamedRaw;
  const body = htmlEscape(truncated);

  // Resolve channel handle from the live DB setting so /setchannel is respected.
  const liveChannel = getPublishChannel();
  const channelHandle = liveChannel.startsWith('@') ? liveChannel : `@${liveChannel}`;

  // Country line: small-caps label + small-caps country name as hashtag + flag
  const name = countryName(c.country || 'XX');
  const nameTag = toSmallCaps(name).replace(/\s+/g, ''); // e.g. ɪʀᴀɴ
  const countryLine = `${toSmallCaps('country')}: #${nameTag}(${c.flag})  ${channelHandle}`;

  return [
    `<pre>${body}</pre>`,
    '',
    countryLine,
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
      const channel = getPublishChannel();
      if (!channel) {
        throw new PublishError('No publish channel configured. Use /setchannel in the bot.', true, false);
      }
      await bot.telegram.sendMessage(channel, text, {
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
