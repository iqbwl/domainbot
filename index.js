import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Bot, InputFile } from 'grammy';
import cron from 'node-cron';
import { parseDomainsCsv } from './lib/csv.js';
import {
  initDb,
  getAllDomains,
  getDomain,
  addOrUpdateDomain,
  deleteDomain,
  updateDomainWhois,
  updateAlertState,
  getExpiringDomains,
  updateDomainOwner,
  getNextDomainToCheck,
  touchDomainChecked
} from './lib/db.js';
import { lookupDomain, calculateDaysLeft } from './lib/whois.js';
import { generateDomainsMarkdown, formatNativeAlertTable } from './lib/markdown.js';

// 1. Validate Environment
const token = process.env.BOT_TOKEN;
if (!token || token.trim() === '' || token === 'YOUR_TELEGRAM_BOT_TOKEN') {
  console.error('❌ ERROR: BOT_TOKEN is not defined in .env file.');
  process.exit(1);
}

const adminIds = new Set(
  (process.env.ADMIN_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number)
);

const allowedGroupIds = new Set(
  (process.env.ALLOWED_GROUP_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(id => id.startsWith('-') ? Number(id) : Number(`-${id}`))
);

const alertChatId = process.env.ALERT_CHAT_ID ? process.env.ALERT_CHAT_ID.trim() : null;
const alertThreadId = process.env.ALERT_THREAD_ID ? parseInt(process.env.ALERT_THREAD_ID.trim(), 10) : null;
const alertCron = process.env.ALERT_CRON || '0 8 * * *'; // Default 08:00 AM daily
const alertThresholds = (process.env.ALERT_THRESHOLDS || '60,30,14,7,3,1,0')
  .split(',')
  .map(s => parseInt(s.trim(), 10))
  .filter(n => !isNaN(n))
  .sort((a, b) => b - a);

// 2. Initialize Database
initDb();
console.log('✅ SQLite Database connected and initialized.');

// 3. Initialize GrammY Bot
const bot = new Bot(token);

// Synchronization state & background worker
let isSyncing = false;
let isBackgroundChecking = false;

// Background Auto-Checker (Queries WHOIS domain 1-by-1 sequentially in the background)
async function runBackgroundAutoCheck() {
  if (isBackgroundChecking || isSyncing) return;
  const domainRecord = getNextDomainToCheck();
  if (!domainRecord) return;

  isBackgroundChecking = true;
  try {
    const info = await lookupDomain(domainRecord.domain);
    if (info && (info.expiredDate || info.registrar !== 'Unknown')) {
      updateDomainWhois(domainRecord.domain, info);
    } else {
      touchDomainChecked(domainRecord.domain);
    }
  } catch (err) {
    touchDomainChecked(domainRecord.domain);
  } finally {
    isBackgroundChecking = false;
  }
}

// Run auto-checker every 12 seconds in the background
const backgroundCheckIntervalMs = parseInt(process.env.BACKGROUND_CHECK_INTERVAL_MS || '12000', 10);
setInterval(() => {
  runBackgroundAutoCheck().catch(() => {});
}, backgroundCheckIntervalMs);


// Helper: Send Native Rich Message (Bot API 10.1) with fallback
async function sendRichOrPlain(chatId, markdown, options = {}) {
  const payload = {
    chat_id: chatId,
    rich_message: { markdown }
  };
  if (options.message_thread_id && !isNaN(options.message_thread_id)) {
    payload.message_thread_id = Number(options.message_thread_id);
  }

  try {
    return await bot.api.raw.sendRichMessage(payload);
  } catch (err) {
    console.warn(`sendRichMessage failed for ${chatId}, falling back to sendMessage: ${err.message}`);
    const sendOpts = { parse_mode: 'Markdown' };
    if (options.message_thread_id && !isNaN(options.message_thread_id)) {
      sendOpts.message_thread_id = Number(options.message_thread_id);
    }
    return await bot.api.sendMessage(chatId, markdown, sendOpts);
  }
}

// Helper: Check if user is an authorized admin
function isAdmin(ctx) {
  const userId = ctx.from?.id;
  return adminIds.size === 0 || adminIds.has(userId);
}

// Helper: Escape special characters for Telegram legacy Markdown
function escapeMd(text) {
  if (!text) return '';
  return String(text).replace(/[*_`\[]/g, '\\$&');
}

// Middleware: Access Control
bot.use(async (ctx, next) => {
  const chatType = ctx.chat?.type;
  const chatId = ctx.chat?.id;

  // In private chat: only registered admins are allowed (e.g. for CSV upload & testalert).
  // Regular users chatting directly with the bot are rejected.
  if (chatType === 'private') {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ *Access Denied*\nThis bot can only be used within authorized groups.', { parse_mode: 'Markdown' });
      return;
    }
  } else if (chatType === 'group' || chatType === 'supergroup') {
    // In group: verify allowed group if specified
    if (allowedGroupIds.size > 0 && !allowedGroupIds.has(chatId)) {
      return; // Ignore silently in unauthorized groups
    }
  }

  await next();
});

// Help Message
function getHelpMessage(isPrivate = false) {
  let msg = `🌐 *Domain Monitoring Bot*

*Commands:*
• \`/domain list\` — Download complete \`.md\` report file with status table
• \`/domain add <domain> <owner>\` — Add domain to monitoring (auto WHOIS)
• \`/domain edit <domain> <new_owner>\` — Update domain owner name instantly
• \`/domain delete <domain>\` — Remove domain from monitoring list
• \`/domain check <domain>\` — Realtime WHOIS check without saving to database
• \`/domain expiring [days]\` — Summary of domains nearing expiration (default: 30 days)
• \`/domain sync\` — Re-sync all domain WHOIS data in the background`;

  if (isPrivate) {
    msg += `
• \`/domain testalert\` — Test dispatching expiration alert notification
• 📎 *Upload CSV:* Send a \`.csv\` file directly to import domains in bulk`;
  }

  msg += `

*Usage Examples:*
• \`/domain add example.co.id Acme Corporation\`
• \`/domain edit example.co.id Tech Global Inc\``;

  return msg;
}

bot.command(['start', 'help'], async (ctx) => {
  const isPrivate = ctx.chat?.type === 'private';
  await ctx.reply(getHelpMessage(isPrivate), { parse_mode: 'Markdown' });
});

bot.command('domain', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  // Strip "/domain" and bot mention if any (e.g. "/domain@botname")
  const parts = text.replace(/^\/domain(?:@\w+)?\s*/i, '').trim().split(/\s+/);
  const action = (parts[0] || '').toLowerCase();

  switch (action) {
    case '':
    case 'help': {
      const isPrivate = ctx.chat?.type === 'private';
      await ctx.reply(getHelpMessage(isPrivate), { parse_mode: 'Markdown' });
      break;
    }

    case 'list': {
      const domains = getAllDomains('days_left ASC');
      if (domains.length === 0) {
        const isPrivate = ctx.chat?.type === 'private';
        const addTip = isPrivate ? ' or upload a CSV file' : '';
        await ctx.reply(`ℹ️ No monitored domains found.\nUse \`/domain add <domain> <owner>\`${addTip} to get started.`, { parse_mode: 'Markdown' });
        return;
      }

      const tz = process.env.TIMEZONE || 'Asia/Jakarta';
      const dParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(new Date());
      const day = dParts.find(p => p.type === 'day')?.value || '01';
      const month = dParts.find(p => p.type === 'month')?.value || '01';
      const year = dParts.find(p => p.type === 'year')?.value || '2026';
      const hour = dParts.find(p => p.type === 'hour')?.value || '00';
      const minute = dParts.find(p => p.type === 'minute')?.value || '00';
      const fileName = `domains_${day}${month}${year}_${hour}${minute}.md`;

      const statusMsg = await ctx.reply(`⏳ Preparing report file \`${fileName}\`...`, { parse_mode: 'Markdown' });
      const mdContent = generateDomainsMarkdown(domains, tz);

      const total = domains.length;
      const expiredCount = domains.filter(d => d.days_left !== null && d.days_left <= 0).length;
      const urgentCount = domains.filter(d => d.days_left !== null && d.days_left > 0 && d.days_left <= 30).length;

      const caption = `📊 *Domain Monitoring Report*\n` +
        `• Total: *${total}* domains\n` +
        `• ⚠️ Expiring Soon ≤ 30 Days: *${urgentCount}*\n` +
        `• 🔴 Expired: *${expiredCount}*\n\n` +
        `_Open the attached .md file to view the full status table._`;

      try {
        await ctx.replyWithDocument(new InputFile(Buffer.from(mdContent, 'utf-8'), fileName), {
          caption,
          parse_mode: 'Markdown'
        });
      } catch (err) {
        await ctx.reply(`❌ Failed to send document: ${err.message}`);
      } finally {
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      }
      break;
    }

    case 'add': {
      const domainName = (parts[1] || '').trim().toLowerCase();
      const ownerParts = parts.slice(2);
      const owner = ownerParts.join(' ').trim();

      if (!domainName || !owner) {
        await ctx.reply(
          `⚠️ *Invalid Format*\n\n` +
          `Usage: \`/domain add <domain> <owner>\`\n` +
          `Example: \`/domain add example.co.id Acme Corporation\``,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (!domainName.includes('.') || domainName.length < 3) {
        await ctx.reply(`❌ Invalid domain name \`${domainName}\`. Please include a valid TLD extension (e.g. .com, .id).`, { parse_mode: 'Markdown' });
        return;
      }

      const progressMsg = await ctx.reply(`🔍 Fetching WHOIS data for \`${domainName}\`...`, { parse_mode: 'Markdown' });

      try {
        const info = await lookupDomain(domainName);
        const record = addOrUpdateDomain({
          domain: domainName,
          owner: owner,
          registrar: info.registrar || 'Unknown',
          registered_date: info.registeredDate,
          expired_date: info.expiredDate,
          days_left: info.daysLeft
        });

        let statusText = '';
        if (record.days_left !== null) {
          if (record.days_left < 0) {
            statusText = `🔴 *EXPIRED* (${Math.abs(record.days_left)} days ago)`;
          } else if (record.days_left === 0) {
            statusText = `🚨 *EXPIRES TODAY!*`;
          } else if (record.days_left <= 7) {
            statusText = `🔥 *CRITICAL* (${record.days_left} days left)`;
          } else if (record.days_left <= 30) {
            statusText = `⚠️ *WARNING* (${record.days_left} days left)`;
          } else {
            statusText = `✅ *OK* (${record.days_left} days left)`;
          }
        } else {
          statusText = `⚠️ *WHOIS expiration date not detected automatically*`;
        }

        const reply = `✅ *Domain Successfully Added to Monitoring!*\n\n` +
          `🌐 *Domain:* \`${record.domain}\`\n` +
          `🏢 *Owner:* ${escapeMd(record.owner)}\n` +
          `🏛️ *Registrar:* ${escapeMd(record.registrar || 'Unknown')}\n` +
          `📅 *Registered:* \`${record.registered_date || '-'}\`\n` +
          `⏳ *Expires:* \`${record.expired_date || '-'}\`\n` +
          `📊 *Status:* ${statusText}\n\n` +
          `_Type \`/domain list\` to download the complete report._`;

        await ctx.api.editMessageText(ctx.chat.id, progressMsg.message_id, reply, { parse_mode: 'Markdown' });
      } catch (err) {
        await ctx.api.editMessageText(ctx.chat.id, progressMsg.message_id, `❌ Failed to process domain: ${err.message}`);
      }
      break;
    }

    case 'edit':
    case 'update':
    case 'setowner': {
      const domainName = (parts[1] || '').trim().toLowerCase();
      const ownerParts = parts.slice(2);
      const newOwner = ownerParts.join(' ').trim();

      if (!domainName || !newOwner) {
        await ctx.reply(
          `⚠️ *Invalid Format*\n\n` +
          `Usage: \`/domain edit <domain> <new_owner>\`\n` +
          `Example: \`/domain edit example.co.id Acme Corporation\``,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const existing = getDomain(domainName);
      if (!existing) {
        await ctx.reply(
          `❌ Domain \`${domainName}\` is not registered in the monitoring database.\n` +
          `Use \`/domain add ${domainName} ${newOwner}\` to add it.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const oldOwner = existing.owner;
      const updated = updateDomainOwner(domainName, newOwner);

      const daysText = updated.days_left !== null
        ? (updated.days_left <= 0 ? '🔴 EXPIRED' : `${updated.days_left} days left`)
        : '-';

      await ctx.reply(
        `✅ *Domain Owner Successfully Updated!*\n\n` +
        `🌐 *Domain:* \`${updated.domain}\`\n` +
        `🏢 *New Owner:* *${escapeMd(updated.owner)}*\n` +
        `📜 *Previous Owner:* _${escapeMd(oldOwner)}_\n` +
        `🏛️ *Registrar:* ${escapeMd(updated.registrar || 'Unknown')}\n` +
        `⏳ *Expires:* \`${updated.expired_date || '-'}\` (${daysText})\n\n` +
        `_Changes saved directly to database._`,
        { parse_mode: 'Markdown' }
      );
      break;
    }

    case 'delete':
    case 'del':
    case 'remove': {
      const targetDomain = (parts[1] || '').trim().toLowerCase();
      if (!targetDomain) {
        await ctx.reply('⚠️ Please provide the domain to delete.\nExample: `/domain delete example.com`', { parse_mode: 'Markdown' });
        return;
      }

      const existing = getDomain(targetDomain);
      if (!existing) {
        await ctx.reply(`⚠️ Domain \`${targetDomain}\` not found in the monitoring database.`, { parse_mode: 'Markdown' });
        return;
      }

      const ok = deleteDomain(targetDomain);
      if (ok) {
        await ctx.reply(`🗑️ Domain \`${targetDomain}\` (Owner: *${escapeMd(existing.owner)}*) successfully removed from monitoring.`, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply(`❌ Failed to delete \`${targetDomain}\`.`);
      }
      break;
    }

    case 'check': {
      const targetDomain = (parts[1] || '').trim().toLowerCase();
      if (!targetDomain) {
        await ctx.reply('⚠️ Please provide the domain to check.\nExample: `/domain check google.com`', { parse_mode: 'Markdown' });
        return;
      }

      const progressMsg = await ctx.reply(`🔍 Fetching live WHOIS data for \`${targetDomain}\`...`, { parse_mode: 'Markdown' });
      try {
        const info = await lookupDomain(targetDomain);

        let statusText = '-';
        if (info.daysLeft !== null) {
          if (info.daysLeft < 0) {
            statusText = `🔴 EXPIRED (${Math.abs(info.daysLeft)} days ago)`;
          } else {
            statusText = `⏳ ${info.daysLeft} days left`;
          }
        }

        const reply = `🔍 *WHOIS / RDAP Lookup Results*\n\n` +
          `🌐 *Domain:* \`${info.domain}\`\n` +
          `🏛️ *Registrar:* ${info.registrar}\n` +
          `📅 *Registered:* \`${info.registeredDate || '-'}\`\n` +
          `⏳ *Expires:* \`${info.expiredDate || '-'}\`\n` +
          `📊 *Time Remaining:* ${statusText}\n` +
          `📡 *Source:* \`${info.source}\`\n\n` +
          `_(Live lookup, not stored in database)_`;

        await ctx.api.editMessageText(ctx.chat.id, progressMsg.message_id, reply, { parse_mode: 'Markdown' });
      } catch (err) {
        await ctx.api.editMessageText(ctx.chat.id, progressMsg.message_id, `❌ Failed to fetch data: ${err.message}`);
      }
      break;
    }

    case 'expiring': {
      const parsedDays = parseInt(parts[1], 10);
      const days = isNaN(parsedDays) || parsedDays <= 0 ? 30 : parsedDays;
      const expiring = getExpiringDomains(days);

      if (expiring.length === 0) {
        await ctx.reply(`✅ *All Healthy!* No domains expiring within ≤ *${days}* days.`, { parse_mode: 'Markdown' });
        return;
      }

      const alertItems = expiring.map(d => ({
        domain: d.domain,
        owner: d.owner,
        expiredDate: d.expired_date,
        daysLeft: d.days_left
      }));

      let msg = `# ⚠️ Domains Expiring Soon (≤ ${days} Days)\n\n`;
      msg += `> Found *${expiring.length}* domains requiring renewal attention\n\n`;
      msg += formatNativeAlertTable(alertItems);
      msg += `\n---\n_Full .md report file attached below._`;

      const sendOpts = {};
      if (ctx.message?.message_thread_id) {
        sendOpts.message_thread_id = ctx.message.message_thread_id;
      }
      await sendRichOrPlain(ctx.chat.id, msg, sendOpts);

      // Prepare and send .md report file like /domain list
      const tz = process.env.TIMEZONE || 'Asia/Jakarta';
      const dParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(new Date());
      const day = dParts.find(p => p.type === 'day')?.value || '01';
      const month = dParts.find(p => p.type === 'month')?.value || '01';
      const year = dParts.find(p => p.type === 'year')?.value || '2026';
      const hour = dParts.find(p => p.type === 'hour')?.value || '00';
      const minute = dParts.find(p => p.type === 'minute')?.value || '00';
      const fileName = `expiring_${days}d_${day}${month}${year}_${hour}${minute}.md`;

      const mdContent = generateDomainsMarkdown(expiring, tz, {
        title: `# ⚠️ Domains Expiring Soon Report (≤ ${days} Days)`,
        daysThreshold: days
      });

      const docOpts = {
        caption: `📄 *Expiring Domains Report (≤ ${days} Days)*\n• Total: *${expiring.length}* domains`,
        parse_mode: 'Markdown'
      };
      if (ctx.message?.message_thread_id) {
        docOpts.message_thread_id = ctx.message.message_thread_id;
      }

      try {
        await ctx.replyWithDocument(new InputFile(Buffer.from(mdContent, 'utf-8'), fileName), docOpts);
      } catch (err) {
        console.error('Failed to send expiring report document:', err);
      }
      break;
    }

    case 'sync': {
      if (isSyncing) {
        await ctx.reply('⚠️ *Sync Already Running*\nWHOIS data synchronization is currently in progress in the background. Please wait a moment.', { parse_mode: 'Markdown' });
        return;
      }

      const domains = getAllDomains();
      if (domains.length === 0) {
        await ctx.reply('ℹ️ Database is empty, no domains to sync.');
        return;
      }

      isSyncing = true;
      const replyChatId = ctx.chat.id;
      const replyThreadId = ctx.message?.message_thread_id;
      const initMsg = await ctx.reply(
        `🔄 *Background Sync Started!*\n` +
        `Updating WHOIS data for *${domains.length}* domains progressively...\n\n` +
        `_The bot remains fully responsive for other commands._`,
        {
          parse_mode: 'Markdown',
          ...(replyThreadId ? { message_thread_id: replyThreadId } : {})
        }
      );

      // Run sync task detached in the background without blocking the bot
      (async () => {
        let updatedCount = 0;
        try {
          for (let i = 0; i < domains.length; i++) {
            const d = domains[i];
            try {
              const info = await lookupDomain(d.domain);
              if (info && info.expiredDate) {
                updateDomainWhois(d.domain, info);
                updatedCount++;
              }
            } catch (e) {
              // ignore individual failure
            }
            await new Promise(r => setTimeout(r, 600)); // polite rate-limit delay
          }

          await bot.api.editMessageText(
            replyChatId,
            initMsg.message_id,
            `✅ *Sync Completed!*\n• Total: *${domains.length}* domains\n• Successfully updated: *${updatedCount}*`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        } catch (err) {
          console.error('Error during detached background sync:', err);
        } finally {
          isSyncing = false;
        }
      })().catch(err => {
        console.error('Unhandled background sync exception:', err);
        isSyncing = false;
      });
      break;
    }

    case 'testalert': {
      // Only available in Private Chat (DM) for Admins
      if (ctx.chat?.type !== 'private') {
        await ctx.reply('⚠️ *Private Chat Only*\nThe `/domain testalert` command can only be executed in a Direct Message (DM) by Admins.', {
          parse_mode: 'Markdown',
          reply_to_message_id: ctx.message?.message_id
        });
        return;
      }

      if (!isAdmin(ctx)) {
        await ctx.reply('⛔ *Access Denied*\nOnly registered administrators can run alert tests.', { parse_mode: 'Markdown' });
        return;
      }

      const targetChat = alertChatId || (adminIds.size > 0 ? Array.from(adminIds)[0] : null);
      if (!targetChat) {
        await ctx.reply('⚠️ Alert destination is not configured in .env (`ALERT_CHAT_ID`).', { parse_mode: 'Markdown' });
        return;
      }

      await ctx.reply(
        `🔄 Sending test alert notification to chat \`${targetChat}\`${alertThreadId ? ` (topic \`${alertThreadId}\`)` : ''}...`,
        { parse_mode: 'Markdown' }
      );

      const ok = await runExpirationAlertCheck(true);
      if (ok) {
        await ctx.reply('✅ Test alert sent successfully! Please check the destination group/topic.', { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('❌ Failed to send test alert. Ensure the bot is a group member with adequate permissions and valid topic ID.', { parse_mode: 'Markdown' });
      }
      break;
    }

    default:
      await ctx.reply(`❓ Command \`/domain ${action}\` not recognized.\nType \`/domain help\` to view the list of available commands.`, { parse_mode: 'Markdown' });
  }
});


// Handler for CSV Document Upload (Direct Import from Telegram - Admin Private Chat Only)
bot.on(':document', async (ctx) => {
  // Only process if sent via Private Chat (DM).
  // Completely ignore if uploaded in groups to avoid interfering with general file sharing.
  if (ctx.chat?.type !== 'private') {
    return;
  }

  const doc = ctx.message.document;
  if (!doc.file_name?.toLowerCase().endsWith('.csv')) {
    return; // Ignore non-CSV files
  }

  if (!isAdmin(ctx)) {
    await ctx.reply('⛔ *Access Denied*\nOnly registered administrators can import CSV files.', {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
    return;
  }

  const statusMsg = await ctx.reply(`📥 Downloading and reading file \`${doc.file_name}\`...`, {
    parse_mode: 'Markdown',
    reply_to_message_id: ctx.message.message_id
  });

  try {
    const file = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Failed to download file: HTTP ${res.status}`);
    const textContent = await res.text();

    // Backup uploaded file to disk
    const saveDir = path.resolve('data', 'uploads');
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = doc.file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
    fs.writeFileSync(path.join(saveDir, `${timestamp}_${safeName}`), textContent, 'utf-8');

    const { items, meta } = parseDomainsCsv(textContent);

    if (items.length === 0) {
      const headerList = meta.headers && meta.headers.length > 0
        ? meta.headers.map(h => `\`${h}\``).join(', ')
        : 'None';
      const errMsg = `⚠️ *No Valid Domains Found in CSV*\n\n` +
        `• *Total Rows:* ${meta.total || 0}\n` +
        `• *Detected Headers:* ${headerList}\n` +
        `• *Issue:* ${meta.error || 'No valid domains found in any column'}\n\n` +
        `_Ensure your CSV contains a domain name column (e.g. \`domain\`, \`Domain Name\`)._`;
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, errMsg, { parse_mode: 'Markdown' });
      return;
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `⏳ Found *${items.length}* valid domains (from ${meta.total} rows).\nProcessing import & deduplication...`,
      { parse_mode: 'Markdown' }
    );

    let createdCount = 0;
    let updatedCount = 0;
    let failedCount = 0;
    let lastProgressUpdate = Date.now();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const { domain, owner, registrar, expiredDate, registeredDate } = item;
      const existing = getDomain(domain);

      if (expiredDate) {
        // Expiration date provided directly in CSV
        addOrUpdateDomain({
          domain,
          owner,
          registrar: registrar || (existing ? existing.registrar : 'Unknown'),
          registered_date: registeredDate || (existing ? existing.registered_date : null),
          expired_date: expiredDate,
          days_left: calculateDaysLeft(expiredDate)
        });
        if (existing) updatedCount++;
        else createdCount++;
      } else if (existing && existing.expired_date) {
        // Duplicate domain already possessing WHOIS data in DB
        addOrUpdateDomain({
          domain,
          owner,
          registrar: registrar || existing.registrar,
          registered_date: registeredDate || existing.registered_date,
          expired_date: existing.expired_date,
          days_left: calculateDaysLeft(existing.expired_date)
        });
        updatedCount++;
      } else {
        // Requires live WHOIS lookup
        try {
          const info = await lookupDomain(domain);
          addOrUpdateDomain({
            domain,
            owner,
            registrar: registrar || info.registrar || 'Unknown',
            registered_date: registeredDate || info.registeredDate,
            expired_date: info.expiredDate,
            days_left: info.daysLeft
          });
          createdCount++;
        } catch (e) {
          failedCount++;
        }
        await new Promise(r => setTimeout(r, 600)); // Rate limit
      }

      // Progress notification per 20 items or 4 seconds
      if (items.length > 25 && (i % 20 === 0 || Date.now() - lastProgressUpdate > 4000)) {
        lastProgressUpdate = Date.now();
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `⏳ Processing domains: *${i + 1}/${items.length}*...\n` +
          `• New: ${createdCount} | Updated: ${updatedCount} | Failed: ${failedCount}`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    }

    const summary = `📊 *CSV Import Summary (\`${doc.file_name}\`)*\n\n` +
      `✅ *New Domains:* ${createdCount}\n` +
      `🔄 *Duplicates Updated:* ${updatedCount}\n` +
      `❌ *Failed:* ${failedCount}\n` +
      `📦 *Total Processed:* ${items.length} domains (from ${meta.total} rows)\n\n` +
      `_Type \`/domain list\` to download the updated report table._`;

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, summary, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Failed to process CSV file: ${err.message}`);
  }
});

// 4. Scheduled Expiration Notification Job (Daily Reminder)
async function runExpirationAlertCheck(isTest = false) {
  console.log('⏰ Running domain expiration alert check...');
  const domains = getAllDomains('days_left ASC');

  // Delivery destinations (Group/Topic + Admin DMs)
  const destinations = [];
  if (alertChatId) {
    const opts = { parse_mode: 'Markdown' };
    if (alertThreadId && !isNaN(alertThreadId)) {
      opts.message_thread_id = alertThreadId;
    }
    destinations.push({ chatId: alertChatId, options: opts, type: 'ALERT_CHAT' });
  }

  for (const adminId of adminIds) {
    if (String(adminId) !== String(alertChatId)) {
      destinations.push({ chatId: adminId, options: { parse_mode: 'Markdown' }, type: 'ADMIN_DM' });
    }
  }

  if (destinations.length === 0) {
    console.log('⚠️ ALERT_CHAT_ID or ADMIN_IDS is not configured for alert dispatch.');
    return false;
  }

  const sendToAll = async (msg) => {
    let sent = 0;
    for (const dest of destinations) {
      try {
        await sendRichOrPlain(dest.chatId, msg, dest.options);
        console.log(`✅ Alert successfully sent to ${dest.type} (${dest.chatId}${dest.options.message_thread_id ? ` topic: ${dest.options.message_thread_id}` : ''})`);
        sent++;
      } catch (err) {
        console.error(`⚠️ Failed to send alert to ${dest.type} (${dest.chatId}): ${err.message}`);
      }
    }
    return sent > 0;
  };

  if (domains.length === 0) {
    if (isTest) {
      const testMsg = `🧪 *DOMAIN MONITORING ALERT TEST*\n\n` +
        `✅ Bot connection to this chat & topic is working properly!\n` +
        `ℹ️ No domains found in database. Add domains using \`/domain add <domain> <owner>\` or upload a CSV file.\n` +
        `Daily alert schedule: \`${alertCron}\``;
      return await sendToAll(testMsg);
    }
    return true;
  }

  // Recalculate latest daysLeft for all domains & collect domains nearing expiration
  const maxThreshold = alertThresholds.length > 0 ? Math.max(...alertThresholds) : 60;
  const alerts = [];

  for (const d of domains) {
    if (!d.expired_date) continue;
    const currentDays = calculateDaysLeft(d.expired_date);

    // Update DB with today's days left calculation
    updateDomainWhois(d.domain, {
      registrar: d.registrar,
      registeredDate: d.registered_date,
      expiredDate: d.expired_date,
      daysLeft: currentDays
    });

    // Alert if domain is already expired or days left <= max threshold (e.g. <= 60 days)
    if (currentDays <= maxThreshold) {
      alerts.push({
        domain: d.domain,
        owner: d.owner,
        registrar: d.registrar || 'Unknown',
        expiredDate: d.expired_date,
        daysLeft: currentDays
      });
      if (!isTest) {
        updateAlertState(d.domain, maxThreshold);
      }
    }
  }

  if (alerts.length === 0) {
    if (isTest) {
      const testMsg = `🧪 *DOMAIN MONITORING ALERT TEST*\n\n` +
        `✅ Bot connection to this chat & topic is working properly!\n` +
        `📊 Total monitored domains: *${domains.length}*\n` +
        `ℹ️ All domains are currently in healthy status (none expiring in ≤ ${maxThreshold} days).\n` +
        `Daily alert schedule: \`${alertCron}\``;
      return await sendToAll(testMsg);
    }
    console.log('✅ Alert check completed. All domains are healthy.');
    return true;
  }

  // Sort alerts with least days left first
  alerts.sort((a, b) => a.daysLeft - b.daysLeft);

  // Format Daily Alert Message (Native Rich Table)
  const tz = process.env.TIMEZONE || 'Asia/Jakarta';
  const tzSuffix = tz === 'Asia/Jakarta' ? 'WIB' : tz;
  const nowStr = new Date().toLocaleString('en-GB', { timeZone: tz });
  const expiredCount = alerts.filter(a => a.daysLeft < 0).length;
  const expiringCount = alerts.length - expiredCount;

  let actionSummary = '';
  if (expiredCount > 0 && expiringCount > 0) {
    actionSummary = `🔴 *${expiredCount}* expired & ⚠️ *${expiringCount}* expiring soon`;
  } else if (expiredCount > 0) {
    actionSummary = `🔴 *${expiredCount}* expired domain(s) needing urgent renewal`;
  } else {
    actionSummary = `⚠️ *${expiringCount}* domain(s) nearing expiration`;
  }

  let alertMsg = isTest ? `# 🧪 DOMAIN EXPIRATION ALERT TEST\n\n` : `# 🚨 DOMAIN EXPIRATION ALERT\n\n`;
  alertMsg += `> *Time:* \`${nowStr} ${tzSuffix}\`  \n`;
  alertMsg += `> *Action Required:* ${actionSummary}\n\n`;

  // Render native GFM table Telegram Bot API 10.1
  alertMsg += formatNativeAlertTable(alerts);
  alertMsg += `\n---\n_Type \`/domain list\` to download the complete report file._`;

  return await sendToAll(alertMsg);
}

// Schedule Daily Cron Alert
cron.schedule(alertCron, () => {
  runExpirationAlertCheck().catch(err => {
    console.error('Error running daily alert check:', err);
  });
}, {
  timezone: process.env.TIMEZONE || 'Asia/Jakarta'
});

console.log(`⏰ Daily cron alert active with pattern: "${alertCron}" (Timezone: ${process.env.TIMEZONE || 'Asia/Jakarta'})`);

// 5. Start GrammY Bot
bot.catch((err) => {
  console.error('Error in bot middleware:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (String(reason).includes('getUpdates') || String(reason).includes('409') || String(reason).includes('GrammyError')) {
    console.error('Fatal Telegram polling error detected. Exiting for PM2 restart...');
    process.exit(1);
  }
});

async function start() {
  console.log('Mendaftarkan bot commands di Telegram...');
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Show help and list of available commands' },
      { command: 'domain', description: 'Manage and monitor domain expirations' },
    ]);
    console.log('Bot commands berhasil didaftarkan.');
  } catch (err) {
    console.warn('Gagal mendaftarkan bot commands:', err.message);
  }

  console.log('Menjalankan bot DomainBot...');
  await bot.start({
    onStart: (botInfo) => {
      console.log(`🚀 DomainBot running as @${botInfo.username}`);
    },
  });
}

start().catch((err) => {
  console.error('Fatal error in bot.start:', err);
  process.exit(1);
});

