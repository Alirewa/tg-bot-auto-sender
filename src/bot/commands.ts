import { Telegraf, Markup, Context } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import config from '../utils/config';
import { getPublishChannel } from './publisher';
import logger from '../utils/logger';
import { readRecentLogs, readLogsFiltered } from '../utils/logReader';
import {
  AnalyticsRepo,
  ConfigRepo,
  SettingsRepo,
  StatsRepo,
  SubsRepo,
} from '../database/repositories';
import { queue } from '../scheduler/queue';
import {
  forceValidateQueue,
  validateQueueStrict,
  validateWithXray,
  runScrapeCycle,
  ScrapeProgressEvent,
} from '../scheduler';
import { findXrayBinary } from '../validator/xray';

const startTimestamp = Date.now();
const DEFAULT_TEMPLATE = '{flag} - #{n} {channel}';

type AwaitingKind = 'add_sub' | 'del_sub' | 'set_template' | 'toggle_sub' | 'set_channel';
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
  const channel = getPublishChannel();
  const channelDisplay = channel || '⚠️ Not set — use /setchannel';

  const text = [
    '<b>tg-bot-auto-sender — admin panel</b>',
    '',
    `Channel:       <code>${channelDisplay}</code>`,
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
      Markup.button.callback('📢 Set Channel', 'act:set_channel'),
      Markup.button.callback('🧩 Template', 'act:template'),
    ],
    [
      Markup.button.callback('🔗 Sources', 'act:subs'),
      Markup.button.callback('🔍 Scan', 'act:scan'),
    ],
    [
      Markup.button.callback('📈 Analytics', 'act:analytics'),
      Markup.button.callback('📡 Sub links', 'act:sublink'),
    ],
    [
      Markup.button.callback('📋 Publish logs', 'act:logs_publish'),
      Markup.button.callback('📄 All logs', 'act:logs_all'),
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

function scanMenu(): { text: string; keyboard: InlineKeyboardMarkup } {
  const xrayInstalled = !!findXrayBinary();
  const text = [
    '<b>🔍 Scan</b>',
    '',
    `Queue: <b>${queue.size()}</b> configs`,
    `xray: <b>${xrayInstalled ? '✅ installed' : '❌ not found'}</b>`,
    '',
    '⏳ <b>Scrape now</b> — fetch new configs from all sources',
    '♻️ <b>Re-check</b> — re-validate current queue (2500ms)',
    '✅ <b>Validate strict</b> — keep only configs with ping &lt;1000ms',
    `🧪 <b>Xray test</b> — ${xrayInstalled ? 'route real HTTP through each config (gold standard)' : 'install xray first (see below)'}`,
    '🗑 <b>Clear queue</b> — empty queue completely',
    ...(xrayInstalled ? [] : [
      '',
      '⚠️ To enable Xray testing, run on server:',
      '<code>bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install</code>',
    ]),
  ].join('\n');

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('⏳ Scrape now', 'act:scrape')],
    [Markup.button.callback('♻️ Re-check queue', 'act:check')],
    [Markup.button.callback('✅ Validate strict (<1000ms)', 'act:validate_strict')],
    [Markup.button.callback(xrayInstalled ? '🧪 Xray test (real VPN check)' : '🧪 Xray — not installed', 'act:validate_xray')],
    [Markup.button.callback('🗑 Clear queue', 'act:clear_queue')],
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

function sublinkText(): string {
  const ghRepo = config.githubRepo;
  const ghBranch = config.githubBranch;
  const subDir = config.subDir;

  if (!config.githubToken || !ghRepo) {
    const subsDir = config.subsDir;
    return [
      '<b>📡 Subscription Files</b>',
      '',
      '⚠️ GitHub publishing not configured.',
      'Set <code>GITHUB_TOKEN</code> and <code>GITHUB_REPO</code> in .env to get public URLs.',
      '',
      '<b>Local files:</b>',
      `<code>${subsDir}/main.txt</code>     (base64, all)`,
      `<code>${subsDir}/healthy.txt</code>  (plain text)`,
      `<code>${subsDir}/vless.txt</code>`,
      `<code>${subsDir}/vmess.txt</code>`,
      `<code>${subsDir}/trojan.txt</code>`,
      `<code>${subsDir}/ss.txt</code>`,
      `<code>${subsDir}/wireguard.txt</code>`,
    ].join('\n');
  }

  const base = `https://raw.githubusercontent.com/${ghRepo}/${ghBranch}/${subDir}`;
  return [
    '<b>📡 Subscription Links</b>',
    '',
    `All (base64):   <code>${base}/main.txt</code>`,
    `Healthy (plain):<code>${base}/healthy.txt</code>`,
    `VLESS:          <code>${base}/vless.txt</code>`,
    `VMess:          <code>${base}/vmess.txt</code>`,
    `Trojan:         <code>${base}/trojan.txt</code>`,
    `SS:             <code>${base}/ss.txt</code>`,
    `WireGuard:      <code>${base}/wireguard.txt</code>`,
  ].join('\n');
}

function analyticsText(): string {
  const summary = AnalyticsRepo.getSummaryLast24h();
  if (summary.cycles === 0) {
    return '<b>📊 Analytics</b>\n\nNo data yet — run a scrape cycle first.';
  }

  const totalPosted = StatsRepo.get('total_posted');
  const healthyRatio =
    summary.totalValidated > 0
      ? Math.round((summary.totalAlive / summary.totalValidated) * 100)
      : 0;
  const publishSuccessRate =
    summary.totalAlive > 0
      ? Math.round((totalPosted / Math.max(totalPosted, 1)) * 100)
      : 0;

  return [
    '<b>📊 Last 24h Analytics</b>',
    '',
    `📦 Cycles run:      <b>${summary.cycles}</b>`,
    `🧪 Validated:       <b>${summary.totalValidated}</b>`,
    `🟢 Alive total:     <b>${summary.totalAlive}</b>`,
    `📉 Healthy ratio:   <b>${healthyRatio}%</b>`,
    `🏆 Best protocol:   <b>${summary.bestProtocol ?? '—'}</b>`,
    `🌍 Best country:    <b>${summary.bestCountry ?? '—'}</b>`,
    `⚡ Avg latency:     <b>${summary.avgLatency !== null ? summary.avgLatency + 'ms' : '—'}</b>`,
    `📬 Total published: <b>${totalPosted}</b>`,
    `✅ Publish rate:    <b>${publishSuccessRate}%</b>`,
  ].join('\n');
}

/** Formats recent log entries for display in Telegram. */
function logsText(publishOnly = false): string {
  const SKIP = new Set(['timestamp', 'level', 'message']);
  const entries = publishOnly
    ? readLogsFiltered('publish:', 20)
    : readRecentLogs(20);

  if (entries.length === 0) {
    if (publishOnly) {
      const autoSend = SettingsRepo.getBool('auto_send', true);
      const qSize = queue.size();
      const channel = getPublishChannel();
      return [
        '<b>📋 Publish Logs</b>',
        '',
        '⚠️ No publish events found in recent logs.',
        '',
        `Auto-send : ${autoSend ? '🟢 ON' : '🔴 OFF'}`,
        `Queue     : <b>${qSize}</b> configs`,
        `Channel   : <code>${channel || '⚠️ not set'}</code>`,
        '',
        ...(autoSend ? [] : ['➡️ Send /on to enable auto-send']),
        ...(!channel ? ['➡️ Send /setchannel @yourchannel'] : []),
        ...(qSize === 0 ? ['➡️ Send /forcescrape to fill the queue'] : []),
        ...(autoSend && channel && qSize > 0
          ? ['ℹ️ Everything looks configured. Update bot and check again in 1 minute.']
          : []),
      ].join('\n');
    }
    return (
      '<b>📋 Recent Logs</b>\n\n' +
      'No logs found yet.\n' +
      'Run /forcescrape or wait for the next publish tick.'
    );
  }

  const lines = entries.map((e) => {
    const icon = e.level === 'error' ? '🔴' : e.level === 'warn' ? '🟡' : '🟢';
    const ts = String(e.timestamp ?? '');
    // ISO → HH:MM:SS
    const time = ts.length >= 19 ? ts.slice(11, 19) : ts.slice(0, 8);
    // collect extra meta fields
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) {
      if (!SKIP.has(k)) meta[k] = v;
    }
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${icon} <code>${time}</code> ${escapeHtml(e.message + metaStr)}`;
  });

  const title = publishOnly
    ? '<b>📋 Publish Logs</b> (last 20)\n\n'
    : '<b>📋 Recent Logs</b> (last 20)\n\n';

  let body = lines.join('\n');
  // Keep well under 4096 chars
  if (title.length + body.length > 3900) {
    body = body.slice(-(3900 - title.length));
    const cut = body.indexOf('\n');
    if (cut > 0) body = body.slice(cut + 1);
  }

  return title + body;
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
  // Register the "/" command list visible in Telegram clients.
  bot.telegram
    .setMyCommands([
      { command: 'start',       description: 'Admin panel (main menu)' },
      { command: 'setchannel',  description: 'Set publish channel — /setchannel @username' },
      { command: 'on',          description: 'Enable auto-send' },
      { command: 'off',         description: 'Disable auto-send' },
      { command: 'forcescrape', description: 'Run scrape cycle now' },
      { command: 'forcecheck',  description: 'Re-validate entire queue' },
      { command: 'stats',       description: 'Overall statistics' },
      { command: 'analytics',   description: '24-hour analytics' },
      { command: 'logs',        description: 'Recent logs' },
      { command: 'sublink',     description: 'Subscription file links' },
      { command: 'listsubs',    description: 'List subscription sources' },
      { command: 'addsub',      description: 'Add source — /addsub https://...' },
      { command: 'delsub',      description: 'Remove source — /delsub <id>' },
      { command: 'template',    description: 'View / change post name template' },
      { command: 'resetcounter',description: 'Reset post counter to zero' },
      { command: 'clearqueue',   description: 'Clear entire queue (with confirmation)' },
      { command: 'ping',        description: 'Health check + uptime' },
      { command: 'cancel',      description: 'Cancel current input prompt' },
    ])
    .catch((err) => {
      logger.warn('setMyCommands failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

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

  bot.command('clearqueue', async (ctx) => {
    const size = queue.size();
    await ctx.reply(
      `⚠️ <b>Clear entire queue?</b>\n\n` +
        `This will permanently delete <b>${size}</b> queued configs from RAM and DB.\n` +
        `They can be re-discovered on the next scrape.\n\n` +
        `This action cannot be undone.`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Yes, clear it', 'act:clear_queue_confirm'),
            Markup.button.callback('❌ Cancel', 'act:menu'),
          ],
        ]).reply_markup,
      },
    );
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

  async function runXrayValidateWithProgress(ctx: Context): Promise<void> {
    const xrayBin = findXrayBinary();
    if (!xrayBin) {
      await ctx.reply(
        '❌ <b>xray not installed</b>\n\nInstall it on the server:\n<code>bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const before = queue.size();
    const header = '🧪 <b>Xray real-VPN test</b>';
    const msg = await ctx.reply(
      `${header}\n\n` +
        `Testing <b>${before}</b> configs by actually routing HTTP through each.\n` +
        `⚠️ This takes longer (~5 concurrent, 10s each). Please wait…`,
      { parse_mode: 'HTML' },
    );
    const messageId = (msg as { message_id: number }).message_id;
    const onProgress = makeProgressEditor(ctx, messageId, header);

    const result = await validateWithXray({ onProgress });

    ctx.telegram
      .editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        `${header}\n\n` +
          `✅ <b>Done.</b>\n\n` +
          `Tested:    ${result.revalidated}\n` +
          `Working:   <b>${result.alive}</b> (real HTTP routed OK)\n` +
          `Removed:   ${result.revalidated - result.alive} (dead / wrong UUID)`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Scan', 'act:scan')]]).reply_markup,
        },
      )
      .catch(() => {});
  }

  async function runValidateStrictWithProgress(ctx: Context, header: string): Promise<void> {
    const before = queue.size();
    const msg = await ctx.reply(
      `${header}\n\n⏳ Testing ${before} configs with 1000ms timeout...\nOnly configs that respond in &lt;1s will survive.`,
      { parse_mode: 'HTML' },
    );
    const messageId = (msg as { message_id: number }).message_id;
    const onProgress = makeProgressEditor(ctx, messageId, header);
    const result = await validateQueueStrict({ onProgress });
    // Final summary edit
    ctx.telegram
      .editMessageText(
        ctx.chat!.id,
        messageId,
        undefined,
        `${header}\n\n✅ Done.\n\nTested:   ${result.revalidated}\nSurvived: <b>${result.alive}</b> (ping &lt;1000ms)\nRemoved:  ${result.revalidated - result.alive}`,
        { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Scan', 'act:scan')]]).reply_markup },
      )
      .catch(() => {});
  }

  bot.command('forcescrape', (ctx) =>
    runScrapeWithProgress(ctx, '<b>⏳ Scrape cycle</b>'),
  );
  bot.command('forcecheck', (ctx) =>
    runCheckWithProgress(ctx, '<b>♻️ Re-checking queue</b>'),
  );

  bot.command('setchannel', async (ctx) => {
    const arg = stripCommand(ctx.message?.text ?? '').trim();
    if (!arg) {
      await ctx.reply(
        'Usage: <code>/setchannel @yourchannel</code> or <code>/setchannel -1001234567890</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }
    SettingsRepo.setString('publish_channel', arg);
    await ctx.reply(`✅ Publish channel set to <code>${escapeHtml(arg)}</code>.\n\nMake sure the bot is an admin with "Post Messages" permission.`, {
      parse_mode: 'HTML',
    });
  });

  bot.command('sublink', async (ctx) => {
    await ctx.reply(sublinkText(), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: backToMenuKb(),
    });
  });

  bot.command('analytics', async (ctx) => {
    await ctx.reply(analyticsText(), {
      parse_mode: 'HTML',
      reply_markup: backToMenuKb(),
    });
  });

  bot.command('logs', async (ctx) => {
    await ctx.reply(logsText(false), {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.callback('📋 Publish only', 'act:logs_publish'),
          Markup.button.callback('📄 All logs', 'act:logs_all'),
        ],
        [Markup.button.callback('⬅️ Main menu', 'act:menu')],
      ]).reply_markup,
    });
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

        case 'clear_queue': {
          const size = queue.size();
          await ctx.answerCbQuery();
          await ctx.editMessageText(
            `⚠️ <b>Clear entire queue?</b>\n\n` +
              `This will permanently delete <b>${size}</b> queued configs from RAM and DB.\n` +
              `They can be re-discovered on the next scrape.\n\n` +
              `This action cannot be undone.`,
            {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [
                  Markup.button.callback('✅ Yes, clear it', 'act:clear_queue_confirm'),
                  Markup.button.callback('❌ Cancel', 'act:menu'),
                ],
              ]).reply_markup,
            },
          );
          return;
        }

        case 'clear_queue_confirm': {
          const deleted = ConfigRepo.deleteAllQueued();
          queue.clear();
          await ctx.answerCbQuery('Queue cleared');
          await ctx.editMessageText(
            `🗑 <b>Queue cleared.</b>\n\n` +
              `Removed <b>${deleted}</b> configs from DB and flushed RAM queue.\n\n` +
              `The next scrape cycle will refill the queue with fresh validated configs.\n` +
              `Tap <b>⏳ Scrape now</b> to trigger immediately.`,
            { parse_mode: 'HTML', reply_markup: backToMenuKb() },
          );
          logger.info('admin: queue cleared manually', { deleted });
          return;
        }

        case 'scan': {
          await ctx.answerCbQuery();
          const sv = scanMenu();
          await ctx.editMessageText(sv.text, { parse_mode: 'HTML', reply_markup: sv.keyboard });
          return;
        }

        case 'scrape':
          await ctx.answerCbQuery('Starting scrape...');
          await runScrapeWithProgress(ctx, '<b>⏳ Scrape cycle</b>');
          return;

        case 'check':
          await ctx.answerCbQuery('Re-checking...');
          await runCheckWithProgress(ctx, '<b>♻️ Re-checking queue</b>');
          return;

        case 'validate_strict':
          await ctx.answerCbQuery('Validating with 1000ms timeout...');
          await runValidateStrictWithProgress(ctx, '<b>✅ Validate strict (&lt;1000ms)</b>');
          return;

        case 'validate_xray':
          await ctx.answerCbQuery('Starting xray validation...');
          await runXrayValidateWithProgress(ctx);
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

        case 'sublink':
          await ctx.answerCbQuery();
          await ctx.editMessageText(sublinkText(), {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: backToMenuKb(),
          });
          return;

        case 'analytics':
          await ctx.answerCbQuery();
          await ctx.editMessageText(analyticsText(), {
            parse_mode: 'HTML',
            reply_markup: backToMenuKb(),
          });
          return;

        case 'logs_publish': {
          await ctx.answerCbQuery();
          const logsKb = Markup.inlineKeyboard([
            [
              Markup.button.callback('📋 Publish only', 'act:logs_publish'),
              Markup.button.callback('📄 All logs', 'act:logs_all'),
            ],
            [Markup.button.callback('⬅️ Main menu', 'act:menu')],
          ]).reply_markup;
          await ctx.editMessageText(logsText(true), {
            parse_mode: 'HTML',
            reply_markup: logsKb,
          });
          return;
        }

        case 'logs_all': {
          await ctx.answerCbQuery();
          const logsKb = Markup.inlineKeyboard([
            [
              Markup.button.callback('📋 Publish only', 'act:logs_publish'),
              Markup.button.callback('📄 All logs', 'act:logs_all'),
            ],
            [Markup.button.callback('⬅️ Main menu', 'act:menu')],
          ]).reply_markup;
          await ctx.editMessageText(logsText(false), {
            parse_mode: 'HTML',
            reply_markup: logsKb,
          });
          return;
        }

        case 'set_channel':
          awaiting.set(userId, 'set_channel');
          await ctx.answerCbQuery();
          await ctx.reply(
            'Send the channel username or ID to publish to.\n\nExamples:\n<code>@mychannel</code>\n<code>-1001234567890</code>\n\n/cancel to abort',
            { parse_mode: 'HTML' },
          );
          return;

        default:
          await ctx.answerCbQuery();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Telegram throws 400 "message is not modified" when we try to edit
      // a message to the exact same content (e.g. clicking Logs twice).
      // Treat it as a no-op rather than an error.
      if (errMsg.includes('message is not modified')) {
        await ctx.answerCbQuery().catch(() => {});
        return;
      }
      logger.error('callback handler error', { action, error: errMsg });
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

    if (kind === 'set_channel') {
      const ch = text.trim();
      if (!ch.startsWith('@') && !ch.startsWith('-')) {
        await ctx.reply(
          '❌ Channel must start with <code>@</code> (username) or <code>-</code> (numeric ID).\n\nTry again or /cancel.',
          { parse_mode: 'HTML' },
        );
        return;
      }
      SettingsRepo.setString('publish_channel', ch);
      await ctx.reply(
        `✅ Publish channel set to <code>${escapeHtml(ch)}</code>.\n\nMake sure the bot is an admin with "Post Messages" permission.`,
        { parse_mode: 'HTML' },
      );
      await showMain(ctx);
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
