import { Telegraf } from 'telegraf';
import config from '../utils/config';
import logger from '../utils/logger';
import {
  ConfigRepo,
  SettingsRepo,
  StatsRepo,
  SubsRepo,
} from '../database/repositories';
import { queue } from '../scheduler/queue';
import { forceValidateQueue, runScrapeCycle } from '../scheduler';

const startTimestamp = Date.now();
const DEFAULT_TEMPLATE = '{flag} - #{n} {channel}';

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function helpText(): string {
  return [
    '<b>🤖 پنل ادمین tg-bot-auto-sender</b>',
    '',
    '<b>وضعیت و کنترل</b>',
    '/status — وضعیت کامل',
    '/on — روشن‌کردن ارسال خودکار',
    '/off — خاموش‌کردن ارسال خودکار',
    '/stats — آمار',
    '/ping — تست سلامت',
    '',
    '<b>قالب ارسال (نام کانفیگ)</b>',
    '/template — نمایش قالب فعلی',
    '<code>/settemplate {flag} - #{n} {channel}</code>',
    '/resetcounter — صفرکردن شمارنده',
    '',
    '<b>لینک‌های Subscription</b>',
    '/listsubs — لیست منابع',
    '<code>/addsub https://...</code>',
    '<code>/delsub 3</code> — حذف با id',
    '<code>/enablesub 3</code> — فعال‌سازی',
    '<code>/disablesub 3</code> — غیرفعال‌سازی',
    '',
    '<b>اقدامات فوری</b>',
    '/forcescrape — اسکرپ فوری',
    '/forcecheck — اعتبارسنجی مجدد صف',
    '',
    'پلیس‌هولدرهای قالب: <code>{flag}</code> <code>{n}</code> <code>{channel}</code> <code>{country}</code>',
  ].join('\n');
}

export function registerCommands(bot: Telegraf): void {
  // /start و /help هر دو منوی ادمین را نمایش می‌دهند
  bot.start(async (ctx) => {
    await ctx.reply(helpText(), { parse_mode: 'HTML' });
  });
  bot.help(async (ctx) => {
    await ctx.reply(helpText(), { parse_mode: 'HTML' });
  });

  // ----- وضعیت / سلامت -----
  bot.command('ping', async (ctx) => {
    const sent = ctx.message?.date ? ctx.message.date * 1000 : Date.now();
    const latency = Date.now() - sent;
    await ctx.reply(
      `🏓 pong\nlatency: <b>${latency}ms</b>\nuptime: <b>${formatUptime(Date.now() - startTimestamp)}</b>`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('status', async (ctx) => {
    const autoSend = SettingsRepo.getBool('auto_send', true);
    const template = SettingsRepo.getString('template', DEFAULT_TEMPLATE);
    const counter = SettingsRepo.getInt('post_counter', 0);
    const subsTotal = SubsRepo.list().length;
    const subsEnabled = SubsRepo.listEnabled().length;
    const queueSize = queue.size();

    await ctx.reply(
      [
        '<b>⚙️ وضعیت ربات</b>',
        '',
        `📡 کانال انتشار: <code>${config.publishChannel}</code>`,
        `🔁 ارسال خودکار: <b>${autoSend ? '🟢 روشن' : '🔴 خاموش'}</b>`,
        `🧩 قالب نام: <code>${escapeHtml(template)}</code>`,
        `🔢 شمارنده‌ی پست: <b>${counter}</b>`,
        `🔗 منابع: <b>${subsEnabled}</b> فعال از <b>${subsTotal}</b>`,
        `📥 صف کنونی: <b>${queueSize}</b>`,
        `⏱ uptime: <b>${formatUptime(Date.now() - startTimestamp)}</b>`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('stats', async (ctx) => {
    const totalPosted = StatsRepo.get('total_posted');
    const totalValidated = StatsRepo.get('total_validated');
    const totalFailed = StatsRepo.get('total_failed');
    const postedToday = StatsRepo.getPostedToday();
    const dbQueued = ConfigRepo.countByStatus('queued');
    const dbDead = ConfigRepo.countByStatus('dead');

    await ctx.reply(
      [
        '<b>📊 آمار</b>',
        '',
        `🟢 منتشرشده‌ی کل: <b>${totalPosted}</b>`,
        `📅 منتشرشده امروز: <b>${postedToday}</b>`,
        `🧪 سالم (کل): <b>${totalValidated}</b>`,
        `❌ ناموفق: <b>${totalFailed}</b>`,
        `📥 صف (RAM): <b>${queue.size()}</b>`,
        `💾 صف (DB): <b>${dbQueued}</b>`,
        `🪦 خراب: <b>${dbDead}</b>`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  // ----- toggle ارسال خودکار -----
  bot.command('on', async (ctx) => {
    SettingsRepo.setBool('auto_send', true);
    await ctx.reply('🟢 ارسال خودکار <b>روشن</b> شد.', { parse_mode: 'HTML' });
  });
  bot.command('off', async (ctx) => {
    SettingsRepo.setBool('auto_send', false);
    await ctx.reply('🔴 ارسال خودکار <b>خاموش</b> شد.', { parse_mode: 'HTML' });
  });

  // ----- template / counter -----
  bot.command('template', async (ctx) => {
    const t = SettingsRepo.getString('template', DEFAULT_TEMPLATE);
    await ctx.reply(
      `قالب فعلی:\n<code>${escapeHtml(t)}</code>\n\nبرای تغییر:\n<code>/settemplate {flag} - #{n} {channel}</code>`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('settemplate', async (ctx) => {
    const arg = stripCommand(ctx.message?.text ?? '');
    if (!arg) {
      await ctx.reply('استفاده: <code>/settemplate {flag} - #{n} {channel}</code>', {
        parse_mode: 'HTML',
      });
      return;
    }
    SettingsRepo.setString('template', arg);
    await ctx.reply(`✅ قالب ثبت شد:\n<code>${escapeHtml(arg)}</code>`, {
      parse_mode: 'HTML',
    });
  });

  bot.command('resetcounter', async (ctx) => {
    SettingsRepo.setInt('post_counter', 0);
    await ctx.reply('🔢 شمارنده صفر شد.');
  });

  // ----- مدیریت لینک‌های sub -----
  bot.command('listsubs', async (ctx) => {
    const list = SubsRepo.list();
    if (list.length === 0) {
      await ctx.reply('هیچ لینکی ثبت نشده. با <code>/addsub URL</code> اضافه کنید.', {
        parse_mode: 'HTML',
      });
      return;
    }
    const lines = list
      .map(
        (s) =>
          `${s.enabled ? '🟢' : '⚪️'} <b>#${s.id}</b> <code>${escapeHtml(s.url)}</code>`,
      )
      .join('\n');
    await ctx.reply(`<b>لینک‌های منبع:</b>\n${lines}`, { parse_mode: 'HTML' });
  });

  bot.command('addsub', async (ctx) => {
    const url = stripCommand(ctx.message?.text ?? '').trim();
    if (!/^https?:\/\/\S+/i.test(url)) {
      await ctx.reply('فرمت نامعتبر. مثال: <code>/addsub https://example.com/sub.txt</code>', {
        parse_mode: 'HTML',
      });
      return;
    }
    SubsRepo.add(url);
    await ctx.reply(`✅ اضافه شد: <code>${escapeHtml(url)}</code>`, { parse_mode: 'HTML' });
  });

  bot.command('delsub', async (ctx) => {
    const id = Number.parseInt(stripCommand(ctx.message?.text ?? ''), 10);
    if (!Number.isFinite(id)) {
      await ctx.reply('استفاده: <code>/delsub 3</code>', { parse_mode: 'HTML' });
      return;
    }
    const ok = SubsRepo.remove(id);
    await ctx.reply(ok ? `🗑 حذف شد #${id}` : `یافت نشد #${id}`);
  });

  bot.command('enablesub', async (ctx) => {
    const id = Number.parseInt(stripCommand(ctx.message?.text ?? ''), 10);
    if (!Number.isFinite(id)) {
      await ctx.reply('استفاده: <code>/enablesub 3</code>', { parse_mode: 'HTML' });
      return;
    }
    const ok = SubsRepo.toggle(id, true);
    await ctx.reply(ok ? `🟢 فعال شد #${id}` : `یافت نشد #${id}`);
  });

  bot.command('disablesub', async (ctx) => {
    const id = Number.parseInt(stripCommand(ctx.message?.text ?? ''), 10);
    if (!Number.isFinite(id)) {
      await ctx.reply('استفاده: <code>/disablesub 3</code>', { parse_mode: 'HTML' });
      return;
    }
    const ok = SubsRepo.toggle(id, false);
    await ctx.reply(ok ? `⚪️ غیرفعال شد #${id}` : `یافت نشد #${id}`);
  });

  // ----- اقدامات فوری -----
  bot.command('forcescrape', async (ctx) => {
    await ctx.reply('⏳ شروع اسکرپ دستی...');
    const r = await runScrapeCycle();
    await ctx.reply(`✅ پایان. کل پارس‌شده: ${r.scraped} | اضافه به صف: ${r.added}`);
  });

  bot.command('forcecheck', async (ctx) => {
    await ctx.reply('⏳ اعتبارسنجی مجدد کل صف...');
    const r = await forceValidateQueue();
    await ctx.reply(`✅ پایان. بررسی‌شده: ${r.revalidated} | باقی‌مانده سالم: ${r.alive}`);
  });

  bot.catch((err, ctx) => {
    logger.error('bot handler error', {
      updateType: ctx.updateType,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function stripCommand(text: string): string {
  // Removes leading "/command" (with or without @botname)
  const m = text.match(/^\/\S+\s+([\s\S]*)$/);
  return m ? m[1] : '';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
