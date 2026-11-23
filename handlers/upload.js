import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { isAdmin, escapeMd } from '../lib/telegram.js';
import { parseDomainsCsv } from '../lib/csv.js';
import { getDomain, addOrUpdateDomain } from '../lib/db.js';
import { calculateDaysLeft, lookupDomain } from '../lib/whois.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.resolve(__dirname, '..', 'data', 'uploads');

export function registerUploadHandler(bot) {
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

    const statusMsg = await ctx.reply(`📥 Downloading and reading file \`${escapeMd(doc.file_name)}\`...`, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });

    try {
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error(`Failed to download file: HTTP ${res.status}`);
      const textContent = await res.text();

      // Backup uploaded file to disk
      if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeName = doc.file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(UPLOADS_DIR, `${timestamp}_${safeName}`), textContent, 'utf-8');

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
            days_left: calculateDaysLeft(expiredDate, config.timezone)
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
            days_left: calculateDaysLeft(existing.expired_date, config.timezone)
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

      const summary = `📊 *CSV Import Summary (\`${escapeMd(doc.file_name)}\`)*\n\n` +
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
}
