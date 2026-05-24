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
import {
  forceValidateQueue,
  runScrapeCycle,
  ScrapeProgressEvent,
} from '../scheduler';

const startTimestamp = Date.now();
const DEFAULT_TEMPLATE = '{flag} - #{n} {channel}';

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

function progressBar(done: number, total: number, width = 18): string {
  if (total <= 0) return '';
  const pct = Math.min(100, Math.round((done / total) * 100));
  const filled = Math.round((pct / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${pct}%`;
}

// --------------------- views ---------------------

function mainMenu(): { text: string; keyboard: InlineKeyboardMarkup } {
  const autoSend = SettingsRepo.getBool('auto_send', true);
  const counter = SettingsRepo.getInt('post_counter', 0);
  const enabledSubs = SubsRepo.listEnabled().length;
  const totalSubs = SubsRepo.list().length;

  const text = [
    '<b>tg-bot-auto-sender — admin panel</b>',
    '',
    `Channel:       <code>${config.publishChannel}</code>`,
    `Auto-send:     <b>${autoSend ? 'ON 🟢' : 'OFF 🔴'}</b>`,
    `Post counter:  <b>${counter}</b>`,
    `Sub sources:   <b>${enabledSubs}/${totalSubs}</b> enabled`,
    `Queue:         <b>${queue.size()}</b>`,
    `Uptime:        <b>${formatUptime(Date.now() - startTimestamp)}</b>`,
  ].join('\n');

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        autoSend ? '🔴 Turn auto-send OFF' : '🟢 Turn auto-send ON',
        autoSend ? 'act:off' : 'act:on',
      ),
    ],
    [
      Markup.button.callback('📊 Stats', 'act:stats'),
      Markup.button.callback('🏓 Ping', 'act:ping'),
    ],
    [
      Markup.button.callback('🔗 Sources', 'act:subs'),
      Markup.button.callback('🧩 Template', 'act:template'),
    ],
    [
      Markup.button.callback('⏳ Scrape now', 'act:scrape'),
      Markup.button.callback('♻️ Re-check queue', 'act:check'),
    ],
    [
      Markup.button.callback('🔢 Reset counter', 'act:reset_counter'),
      Markup.button.callback('🔄 Refresh', 'act:menu'),
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
    : '— no sources yet.';

  const text = ['<b>🔗 Subscription sources</b>', '', lines].join('\n');

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback('➕ Add source', 'act:add_sub'),
      Markup.button.callback('🗑 Delete source', 'act:del_sub'),
    ],
    [
      Markup.button.callback('🟢/⚪️ Toggle', 'act:toggle_sub'),
      Markup.button.callback('🔄 Refresh', 'act:subs'),
    ],
    [Markup.button.callback('⬅️ Main menu', 'act:menu')],
  ]).reply_markup;

  return { text, keyboard: kb };
}

function templateMenu(): { text: string; keyboard: InlineKeyboardMarkup } {
  const t = SettingsRepo.getString('template', DEFAULT_TEMPLATE);
  const text = [
    '<b>🧩 Config name template</b>',
    '',
    `Current:\n<code>${escapeHtml(t)}</code>`,
    '',
    'Placeholders:',
    '<code>{flag}</code>     country flag emoji',
    '<code>{n}</code>        post counter',
    '<code>{channel}</code>  channel handle',
    '<code>{country}</code>  ISO-2 country code',
  ].join('\n');

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Edit template', 'act:set_template')],
    [Markup.button.callback('↩️ Reset to default', 'act:reset_template')],
    [Markup.button.callback('⬅️ Main menu', 'act:menu')],
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
    '<b>📊 Stats</b>',
    '',
    `🟢 Total posted:     <b>${totalPosted}</b>`,
    `📅 Posted today:     <b>${postedToday}</b>`,
    `🧪 Validated alive:  <b>${totalValidated}</b>`,
    `❌ Failed:           <b>${totalFailed}</b>`,
    `📥 Queue (RAM):      <b>${queue.size()}</b>`,
    `💾 Queue (DB):       <b>${dbQueued}</b>`,
    `🪦 Dead:             <b>${dbDead}</b>`,
  ].join('\n');
}

function backToMenuKb(): InlineKeyboardMarkup {
  return Markup.inlineKeyboard([[Markup.button.callback('⬅️ Main menu', 'act:menu')]])
    .reply_markup;
}

async function showMain(ctx: Context, edit = false): Promise<void> {
  const v = mainMenu();
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
}

function stripCommand(text: string): string {
  const m = text.match(/^\/\S+\s+([\s\S]*)$/);
  return m ? m[1] : '';
}

// --------------------- progress-message helper ---------------------

/**
 * Returns a throttled edit-progress callback for a message we just sent.
 * Telegram allows ~1 edit/sec per chat; we throttle to 1.2s to be safe.
 */
function makeProgressEditor(
  ctx: Context,
  messageId: number,
  header: string,
): (e: ScrapeProgressEvent) => void {
  let lastEdit = 0;
  const minIntervalMs = 1200;

  return (e: ScrapeProgressEvent) => {
    const now = Date.now();
    const isFinal = e.phase === 'done';
    if (!isFinal && now - lastEdit < minIntervalMs) return;
    lastEdit = now;

    let body = '';
    switch (e.phase) {
      case 'fetching':
        body = '⬇️  Fetching sources...';
        break;
      case 'parsing':
        body = `🔎 Parsed ${e.scraped ?? 0} configs from sources.`;
        break;
      case 'validating': {
        const total = e.total ?? 0;
        const done = e.done ?? 0;
        const alive = e.alive ?? 0;
        body = [
          `🧪 Validating ${done}/${total}`,
          progressBar(done, total),
          `   alive so far: ${alive}`,
        ].join('\n');
        break;
      }
      case 'done': {
        const scraped = e.scraped ?? 0;
        const fresh = e.fresh ?? 0;
        const alive = e.alive ?? 0;
        body = [
          '✅ Done.',
          '',
          `Parsed:    ${scraped}`,
          `Fresh:     ${fresh}`,
          `Alive:     ${alive}`,
          `Queue:     ${queue.size()}`,
        ].join('\n');
        break;
      }
    }

    const text = `${header}\n\n${body}`;
    ctx.telegram
      .editMessageText(ctx.chat!.id, messageId, undefined, text, { parse_mode: 'HTML' })
      .catch((err) => {
        // Ignore "message is not modified" — happens when nothing changed.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('message is not modified')) {
          logger.debug('progress edit failed', { error: msg });
        }
      });
  };
}

// --------------------- registration ---------------------

export function registerCommands(bot: Telegraf): void {
  bot.start((ctx) => showMain(ctx));
  bot.help((ctx) => showMain(ctx));
  bot.command('menu', (ctx) => showMain(ctx));

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
    await ctx.reply('🟢 Auto-send is now ON.');
  });
  bot.command('off', async (ctx) => {
    SettingsRepo.setBool('auto_send', false);
    await ctx.reply('🔴 Auto-send is now OFF.');
  });

  bot.command('template', async (ctx) => {
    const v = templateMenu();
    await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
  });
  bot.command('settemplate', async (ctx) => {
    const arg = stripCommand(ctx.message?.text ?? '');
    if (!arg) {
      await ctx.reply('Usage: <code>/settemplate {flag} - #{n} {channel}</code>', {
        parse_mode: 'HTML',
      });
      return;
    }
    SettingsRepo.setString('template', arg);
    await ctx.reply(`✅ Template saved:\n<code>${escapeHtml(arg)}</code>`, {
      parse_mode: 'HTML',
    });
  });
  bot.command('resetcounter', async (ctx) => {
    SettingsRepo.setInt('post_counter', 0);
    await ctx.reply('🔢 Counter reset to zero.');
  });

  bot.command('listsubs', async (ctx) => {
    const v = subsMenu();
    await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
  });
  bot.command('addsub', async (ctx) => {
    const url = stripCommand(ctx.message?.text ?? '').trim();
    if (!/^https?:\/\/\S+/i.test(url)) {
      await ctx.reply('Example: <code>/addsub https://example.com/sub.txt</code>', {
        parse_mode: 'HTML',
      });
      return;
    }
    SubsRepo.add(url);
    await ctx.reply(`✅ Added:\n<code>${escapeHtml(url)}</code>`, { parse_mode: 'HTML' });
  });
  bot.command('delsub', async (ctx) => {
    const id = Number.parseInt(stripCommand(ctx.message?.text ?? ''), 10);
    if (!Number.isFinite(id)) {
      await ctx.reply('Usage: <code>/delsub 3</code>', { parse_mode: 'HTML' });
      return;
    }
    const ok = SubsRepo.remove(id);
    await ctx.reply(ok ? `🗑 Deleted #${id}` : `Not found #${id}`);
  });
  bot.command('enablesub', async (ctx) => {
    const id = Number.parseInt(stripCommand(ctx.message?.text ?? ''), 10);
    if (!Number.isFinite(id)) return;
    const ok = SubsRepo.toggle(id, true);
    await ctx.reply(ok ? `🟢 Enabled #${id}` : `Not found #${id}`);
  });
  bot.command('disablesub', async (ctx) => {
    const id = Number.parseInt(stripCommand(ctx.message?.text ?? ''), 10);
    if (!Number.isFinite(id)) return;
    const ok = SubsRepo.toggle(id, false);
    await ctx.reply(ok ? `⚪️ Disabled #${id}` : `Not found #${id}`);
  });

  // Scrape and check now support live progress.
  async function runScrapeWithProgress(ctx: Context, header: string): Promise<void> {
    const msg = await ctx.reply(`${header}\n\n⏳ Starting...`, { parse_mode: 'HTML' });
    const messageId = (msg as { message_id: number }).message_id;
    const onProgress = makeProgressEditor(ctx, messageId, header);
    await runScrapeCycle({ onProgress });
  }

  async function runCheckWithProgress(ctx: Context, header: string): Promise<void> {
    const msg = await ctx.reply(`${header}\n\n⏳ Starting...`, { parse_mode: 'HTML' });
    const messageId = (msg as { message_id: number }).message_id;
    const onProgress = makeProgressEditor(ctx, messageId, header);
    await forceValidateQueue({ onProgress });
  }

  bot.command('forcescrape', (ctx) =>
    runScrapeWithProgress(ctx, '<b>⏳ Scrape cycle</b>'),
  );
  bot.command('forcecheck', (ctx) =>
    runCheckWithProgress(ctx, '<b>♻️ Re-checking queue</b>'),
  );

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
          await ctx.answerCbQuery('Auto-send ON');
          await showMain(ctx, true);
          return;

        case 'off':
          SettingsRepo.setBool('auto_send', false);
          await ctx.answerCbQuery('Auto-send OFF');
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
          await ctx.answerCbQuery('Template reset');
          {
            const v = templateMenu();
            await ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
          }
          return;

        case 'reset_counter':
          SettingsRepo.setInt('post_counter', 0);
          await ctx.answerCbQuery('Counter reset');
          await showMain(ctx, true);
          return;

        case 'scrape':
          await ctx.answerCbQuery('Starting scrape...');
          await runScrapeWithProgress(ctx, '<b>⏳ Scrape cycle</b>');
          return;

        case 'check':
          await ctx.answerCbQuery('Re-checking...');
          await runCheckWithProgress(ctx, '<b>♻️ Re-checking queue</b>');
          return;

        case 'add_sub':
          awaiting.set(userId, 'add_sub');
          await ctx.answerCbQuery();
          await ctx.reply(
            'Send the source URL (e.g. <code>https://example.com/sub.txt</code>)\n\n/cancel to abort',
            { parse_mode: 'HTML' },
          );
          return;

        case 'del_sub':
          awaiting.set(userId, 'del_sub');
          await ctx.answerCbQuery();
          await ctx.reply(
            'Send the source id to delete (e.g. <code>3</code>)\n\n/cancel to abort',
            { parse_mode: 'HTML' },
          );
          return;

        case 'toggle_sub':
          awaiting.set(userId, 'toggle_sub');
          await ctx.answerCbQuery();
          await ctx.reply('Send the source id to toggle enabled/disabled\n\n/cancel to abort');
          return;

        case 'set_template':
          awaiting.set(userId, 'set_template');
          await ctx.answerCbQuery();
          await ctx.reply(
            'Send the new template (e.g. <code>{flag} - #{n} {channel}</code>)\n\n/cancel to abort',
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
        await ctx.answerCbQuery('Error');
      } catch {
        /* ignore */
      }
    }
  });

  bot.command('cancel', async (ctx) => {
    if (awaiting.delete(ctx.from!.id)) {
      await ctx.reply('❎ Cancelled.');
    } else {
      await ctx.reply('Nothing was waiting for input.');
    }
  });

  bot.on('text', async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    const kind = awaiting.get(userId);
    if (!kind) return;
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    awaiting.delete(userId);

    if (kind === 'add_sub') {
      if (!/^https?:\/\/\S+/i.test(text)) {
        await ctx.reply('❌ Invalid URL. Use the menu again.');
        return;
      }
      SubsRepo.add(text);
      await ctx.reply(`✅ Added:\n<code>${escapeHtml(text)}</code>`, { parse_mode: 'HTML' });
      const v = subsMenu();
      await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
      return;
    }

    if (kind === 'del_sub') {
      const id = Number.parseInt(text, 10);
      if (!Number.isFinite(id)) {
        await ctx.reply('❌ id must be a number.');
        return;
      }
      const ok = SubsRepo.remove(id);
      await ctx.reply(ok ? `🗑 Deleted #${id}` : `Not found #${id}`);
      const v = subsMenu();
      await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
      return;
    }

    if (kind === 'toggle_sub') {
      const id = Number.parseInt(text, 10);
      if (!Number.isFinite(id)) {
        await ctx.reply('❌ id must be a number.');
        return;
      }
      const all = SubsRepo.list();
      const found = all.find((s) => s.id === id);
      if (!found) {
        await ctx.reply(`Not found #${id}`);
        return;
      }
      const newState = !found.enabled;
      SubsRepo.toggle(id, newState);
      await ctx.reply(newState ? `🟢 Enabled #${id}` : `⚪️ Disabled #${id}`);
      const v = subsMenu();
      await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard });
      return;
    }

    if (kind === 'set_template') {
      SettingsRepo.setString('template', text);
      await ctx.reply(`✅ Template saved:\n<code>${escapeHtml(text)}</code>`, {
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
