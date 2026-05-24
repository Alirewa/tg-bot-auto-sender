import { Telegraf, Markup, Context } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
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

// Simple in-memory wizard state: which input the admin is expected to send next.
type AwaitingKind = 'add_sub' | 'del_sub' | 'set_template' | 'toggle_sub';
const awaiting = new Map<number, AwaitingKind>();

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --------------------- views ---------------------

function mainMenu(): { text: string; keyboard: InlineKeyboardMarkup } {
  const autoSend = SettingsRepo.getBool('auto_send', true);
  const counter = SettingsRepo.getInt('post_counter', 0);
  const enabledSubs = SubsRepo.listEnabled().length;
  const totalSubs = SubsRepo.list().length;

  const text = [
    '<b>🤖 پنل ادمین tg-bot-auto-sender</b>',
    '',
    `📡 کانال: <code>${config.publishChannel}</code>`,
    `🔁 ارسال خودکار: <b>${autoSend ? '🟢 روشن' : '🔴 خاموش'}</b>`,
    `🔢 شمارنده پست: <b>${counter}</b>`,
    `🔗 منابع فعال: <b>${enabledSubs}</b>/<b>${totalSubs}</b>`,
    `📥 صف فعلی: <b>${queue.size()}</b>`,
    `⏱ uptime: <b>${formatUptime(Date.now() - startTimestamp)}</b>`,
  ].join('\n');

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(autoSend ? '🔴 خاموش‌کردن ارسال' : '🟢 روشن‌کردن ارسال', autoSend ? 'act:off' : 'act:on'),
    ],
    [
      Markup.button.callback('📊 آمار', 'act:stats'),
      Markup.button.callback('🏓 پینگ', 'act:ping'),
    ],
    [
      Markup.button.callback('🔗 منابع', 'act:subs'),
      Markup.button.callback('🧩 قالب نام', 'act:template'),
    ],
    [
      Markup.button.callback('⏳ اسکرپ فوری', 'act:scrape'),
      Markup.button.callback('♻️ بررسی مجدد', 'act:check'),
    ],
    [
      Markup.button.callback('🔢 صفر کردن شمارنده', 'act:reset_counter'),
      Markup.button.callback('🔄 رفرش', 'act:menu'),
    ],
  ]).reply_markup;

  return { text, keyboard: kb };
}

function subsMenu(): { text: string; keyboard: InlineKeyboardMarkup } {
  const list = SubsRepo.list();
  const lines = list.length
    ? list
        .map(
          (s) =>
            `${s.enabled ? '🟢' : '⚪️'} <b>#${s.id}</b> <code>${escapeHtml(s.url)}</code>`,
        )
        .join('\n')
    : '— هیچ منبعی ثبت نشده.';

  const text = ['<b>🔗 لینک‌های Subscription</b>', '', lines].join('\n');

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback('➕ افزودن منبع', 'act:add_sub'),
      Markup.button.callback('🗑 حذف منبع', 'act:del_sub'),
    ],
    [
      Markup.button.callback('🟢/⚪️ فعال/غیرفعال', 'act:toggle_sub'),
      Markup.button.callback('🔄 رفرش', 'act:subs'),
    ],
    [Markup.button.callback('⬅️ منوی اصلی', 'act:menu')],
  ]).reply_markup;

  return { text, keyboard: kb };
}

function templateMenu(): { text: string; keyboard: InlineKeyboardMarkup } {
  const t = SettingsRepo.getString('template', DEFAULT_TEMPLATE);
  const text = [
    '<b>🧩 قالب نام کانفیگ</b>',
    '',
    `قالب فعلی:\n<code>${escapeHtml(t)}</code>`,
    '',
    'پلیس‌هولدرها:',
    '<code>{flag}</code> پرچم کشور',
    '<code>{n}</code> شمارنده',
    '<code>{channel}</code> هندل کانال',
    '<code>{country}</code> کد دو حرفی کشور',
  ].join('\n');

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('✏️ تغییر قالب', 'act:set_template')],
    [Markup.button.callback('↩️ بازگشت به پیش‌فرض', 'act:reset_template')],
    [Markup.button.callback('⬅️ منوی اصلی', 'act:menu')],
  ]).reply_markup;

  return { text, keyboard: kb };
}

function statsText(): string {
  const totalPosted = StatsRepo.get('total_posted');
  const totalValidated = StatsRepo.get('total_validated');
  const totalFailed = StatsRepo.get('total_failed');
  const postedToday = StatsRepo.getPostedToday();
  const dbQueued = ConfigRepo.countByStatus('queued');
  const dbDead = ConfigRepo.countByStatus('dead');

  return [
    '<b>📊 آمار</b>',
    '',
    `🟢 منتشرشده‌ی کل: <b>${totalPosted}</b>`,
    `📅 منتشرشده امروز: <b>${postedToday}</b>`,
    `🧪 سالم (کل): <b>${totalValidated}</b>`,
    `❌ ناموفق: <b>${totalFailed}</b>`,
    `📥 صف (RAM): <b>${queue.size()}</b>`,
    `💾 صف (DB): <b>${dbQueued}</b>`,
    `🪦 خراب: <b>${dbDead}</b>`,
  ].join('\n');
}

function backToMenuKb(): InlineKeyboardMarkup {
  return Markup.inlineKeyboard([[Markup.button.callback('⬅️ منوی اصلی', 'act:menu')]])
    .reply_markup;
}

// --------------------- helpers ---------------------

async function showMain(ctx: Context, edit = false): Promise<void> {
  const v = mainMenu();
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
      return;
    } catch {
      /* fall through to new send if edit fails (e.g. content unchanged) */
    }
  }
  await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
}

function stripCommand(text: string): string {
  const m = text.match(/^\/\S+\s+([\s\S]*)$/);
  return m ? m[1] : '';
}

// --------------------- registration ---------------------

export function registerCommands(bot: Telegraf): void {
  // /start و /help و /menu همگی منوی اصلی را نشان می‌دهند.
  bot.start((ctx) => showMain(ctx));
  bot.help((ctx) => showMain(ctx));
  bot.command('menu', (ctx) => showMain(ctx));

  // ---------- legacy slash commands (still work) ----------

  bot.command('ping', async (ctx) => {
    const sent = ctx.message?.date ? ctx.message.date * 1000 : Date.now();
    const latency = Date.now() - sent;
    await ctx.reply(
      `🏓 pong\nlatency: <b>${latency}ms</b>\nuptime: <b>${formatUptime(Date.now() - startTimestamp)}</b>`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('status', (ctx) => showMain(ctx));
  bot.command('stats', async (ctx) =>
    ctx.reply(statsText(), { parse_mode: 'HTML', reply_markup: backToMenuKb() }),
  );

  bot.command('on', async (ctx) => {
    SettingsRepo.setBool('auto_send', true);
    await ctx.reply('🟢 ارسال خودکار روشن شد.');
  });
  bot.command('off', async (ctx) => {
    SettingsRepo.setBool('auto_send', false);
    await ctx.reply('🔴 ارسال خودکار خاموش شد.');
  });

  bot.command('template', async (ctx) => {
    const v = templateMenu();
    await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
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

  bot.command('listsubs', async (ctx) => {
    const v = subsMenu();
    await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
  });
  bot.command('addsub', async (ctx) => {
    const url = stripCommand(ctx.message?.text ?? '').trim();
    if (!/^https?:\/\/\S+/i.test(url)) {
      await ctx.reply('مثال: <code>/addsub https://example.com/sub.txt</code>', {
        parse_mode: 'HTML',
      });
      return;
    }
    SubsRepo.add(url);
    await ctx.reply(`✅ اضافه شد:\n<code>${escapeHtml(url)}</code>`, { parse_mode: 'HTML' });
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
    if (!Number.isFinite(id)) return;
    const ok = SubsRepo.toggle(id, true);
    await ctx.reply(ok ? `🟢 فعال شد #${id}` : `یافت نشد #${id}`);
  });
  bot.command('disablesub', async (ctx) => {
    const id = Number.parseInt(stripCommand(ctx.message?.text ?? ''), 10);
    if (!Number.isFinite(id)) return;
    const ok = SubsRepo.toggle(id, false);
    await ctx.reply(ok ? `⚪️ غیرفعال شد #${id}` : `یافت نشد #${id}`);
  });

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

  // ---------- inline button callbacks ----------

  bot.on('callback_query', async (ctx) => {
    const data =
      'data' in ctx.callbackQuery! && typeof ctx.callbackQuery.data === 'string'
        ? ctx.callbackQuery.data
        : '';
    if (!data.startsWith('act:')) {
      await ctx.answerCbQuery();
      return;
    }
    const action = data.slice(4);
    const userId = ctx.from?.id ?? 0;

    try {
      switch (action) {
        case 'menu':
          await ctx.answerCbQuery();
          await showMain(ctx, true);
          return;

        case 'on':
          SettingsRepo.setBool('auto_send', true);
          await ctx.answerCbQuery('🟢 روشن شد');
          await showMain(ctx, true);
          return;

        case 'off':
          SettingsRepo.setBool('auto_send', false);
          await ctx.answerCbQuery('🔴 خاموش شد');
          await showMain(ctx, true);
          return;

        case 'stats':
          await ctx.answerCbQuery();
          await ctx.editMessageText(statsText(), {
            parse_mode: 'HTML',
            reply_markup: backToMenuKb(),
          });
          return;

        case 'ping': {
          await ctx.answerCbQuery();
          const lat = Date.now() - (ctx.callbackQuery?.message?.date ?? 0) * 1000;
          await ctx.editMessageText(
            `🏓 pong\nlatency: <b>${lat}ms</b>\nuptime: <b>${formatUptime(Date.now() - startTimestamp)}</b>`,
            { parse_mode: 'HTML', reply_markup: backToMenuKb() },
          );
          return;
        }

        case 'subs': {
          await ctx.answerCbQuery();
          const v = subsMenu();
          await ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
          return;
        }

        case 'template': {
          await ctx.answerCbQuery();
          const v = templateMenu();
          await ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
          return;
        }

        case 'reset_template':
          SettingsRepo.setString('template', DEFAULT_TEMPLATE);
          await ctx.answerCbQuery('قالب پیش‌فرض اعمال شد');
          {
            const v = templateMenu();
            await ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
          }
          return;

        case 'reset_counter':
          SettingsRepo.setInt('post_counter', 0);
          await ctx.answerCbQuery('شمارنده صفر شد');
          await showMain(ctx, true);
          return;

        case 'scrape':
          await ctx.answerCbQuery('در حال اجرا...');
          {
            const r = await runScrapeCycle();
            await ctx.reply(
              `✅ اسکرپ پایان. کل: ${r.scraped} | اضافه به صف: ${r.added}`,
              { reply_markup: backToMenuKb() },
            );
          }
          return;

        case 'check':
          await ctx.answerCbQuery('در حال بررسی...');
          {
            const r = await forceValidateQueue();
            await ctx.reply(
              `✅ بررسی پایان. بررسی‌شده: ${r.revalidated} | سالم: ${r.alive}`,
              { reply_markup: backToMenuKb() },
            );
          }
          return;

        case 'add_sub':
          awaiting.set(userId, 'add_sub');
          await ctx.answerCbQuery();
          await ctx.reply(
            'URL منبع را بفرستید (مثال: <code>https://example.com/sub.txt</code>)\n\nبرای انصراف /cancel',
            { parse_mode: 'HTML' },
          );
          return;

        case 'del_sub':
          awaiting.set(userId, 'del_sub');
          await ctx.answerCbQuery();
          await ctx.reply('id منبع برای حذف را بفرستید (مثلاً <code>3</code>)\n\nانصراف: /cancel', {
            parse_mode: 'HTML',
          });
          return;

        case 'toggle_sub':
          awaiting.set(userId, 'toggle_sub');
          await ctx.answerCbQuery();
          await ctx.reply(
            'id منبع برای تغییر وضعیت (فعال/غیرفعال) را بفرستید\n\nانصراف: /cancel',
          );
          return;

        case 'set_template':
          awaiting.set(userId, 'set_template');
          await ctx.answerCbQuery();
          await ctx.reply(
            'قالب جدید را بفرستید (مثال: <code>{flag} - #{n} {channel}</code>)\n\nانصراف: /cancel',
            { parse_mode: 'HTML' },
          );
          return;

        default:
          await ctx.answerCbQuery();
      }
    } catch (err) {
      logger.error('callback handler error', {
        action,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await ctx.answerCbQuery('خطا رخ داد');
      } catch {
        /* ignore */
      }
    }
  });

  // ---------- /cancel for wizard ----------
  bot.command('cancel', async (ctx) => {
    if (awaiting.delete(ctx.from!.id)) {
      await ctx.reply('❎ انصراف داده شد.');
    } else {
      await ctx.reply('چیزی در انتظار ورودی نبود.');
    }
  });

  // ---------- text handler for wizard inputs ----------
  bot.on('text', async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    const kind = awaiting.get(userId);
    if (!kind) return; // ignore plain text outside wizard
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return; // let command handlers deal

    awaiting.delete(userId);

    if (kind === 'add_sub') {
      if (!/^https?:\/\/\S+/i.test(text)) {
        await ctx.reply('❌ URL نامعتبر بود. دوباره از منو امتحان کنید.');
        return;
      }
      SubsRepo.add(text);
      await ctx.reply(`✅ اضافه شد:\n<code>${escapeHtml(text)}</code>`, { parse_mode: 'HTML' });
      const v = subsMenu();
      await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
      return;
    }

    if (kind === 'del_sub') {
      const id = Number.parseInt(text, 10);
      if (!Number.isFinite(id)) {
        await ctx.reply('❌ id باید عدد باشد.');
        return;
      }
      const ok = SubsRepo.remove(id);
      await ctx.reply(ok ? `🗑 حذف شد #${id}` : `یافت نشد #${id}`);
      const v = subsMenu();
      await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
      return;
    }

    if (kind === 'toggle_sub') {
      const id = Number.parseInt(text, 10);
      if (!Number.isFinite(id)) {
        await ctx.reply('❌ id باید عدد باشد.');
        return;
      }
      const all = SubsRepo.list();
      const found = all.find((s) => s.id === id);
      if (!found) {
        await ctx.reply(`یافت نشد #${id}`);
        return;
      }
      const newState = found.enabled ? false : true;
      SubsRepo.toggle(id, newState);
      await ctx.reply(newState ? `🟢 فعال شد #${id}` : `⚪️ غیرفعال شد #${id}`);
      const v = subsMenu();
      await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
      return;
    }

    if (kind === 'set_template') {
      SettingsRepo.setString('template', text);
      await ctx.reply(`✅ قالب ثبت شد:\n<code>${escapeHtml(text)}</code>`, {
        parse_mode: 'HTML',
      });
      const v = templateMenu();
      await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
      return;
    }
  });

  bot.catch((err, ctx) => {
    logger.error('bot handler error', {
      updateType: ctx.updateType,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
