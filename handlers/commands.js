import { InputFile } from 'grammy';
import { config } from '../config.js';
import { syncState } from '../services/syncState.js';
import { runExpirationAlertCheck } from '../services/alertService.js';
import { isAdmin, escapeMd, sendRichOrPlain, getHelpMessage } from '../lib/telegram.js';
import {
  getAllDomains,
  getDomain,
  addOrUpdateDomain,
  deleteDomain,
  updateDomainWhois,
  getExpiringDomains,
  updateDomainOwner
} from '../lib/db.js';
import { lookupDomain } from '../lib/whois.js';
import { generateDomainsMarkdown, formatNativeAlertTable } from '../lib/markdown.js';

export function registerCommands(bot) {
  // 1. /start and /help command
  bot.command(['start', 'help'], async (ctx) => {
    const isPrivate = ctx.chat?.type === 'private';
    await ctx.reply(getHelpMessage(isPrivate), { parse_mode: 'Markdown' });
  });

  // 2. /domain command
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

        const tz = config.timezone;
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
        await sendRichOrPlain(bot, ctx.chat.id, msg, sendOpts);

        // Prepare and send .md report file
        const tz = config.timezone;
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
        if (syncState.isSyncing) {
          await ctx.reply('⚠️ *Sync Already Running*\nWHOIS data synchronization is currently in progress in the background. Please wait a moment.', { parse_mode: 'Markdown' });
          return;
        }

        const domains = getAllDomains();
        if (domains.length === 0) {
          await ctx.reply('ℹ️ Database is empty, no domains to sync.');
          return;
        }

        syncState.isSyncing = true;
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
            syncState.isSyncing = false;
          }
        })().catch(err => {
          console.error('Unhandled background sync exception:', err);
          syncState.isSyncing = false;
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

        const targetChat = config.alertChatId || (config.adminIds.size > 0 ? Array.from(config.adminIds)[0] : null);
        if (!targetChat) {
          await ctx.reply('⚠️ Alert destination is not configured in .env (`ALERT_CHAT_ID`).', { parse_mode: 'Markdown' });
          return;
        }

        await ctx.reply(
          `🔄 Sending test alert notification to chat \`${targetChat}\`${config.alertThreadId ? ` (topic \`${config.alertThreadId}\`)` : ''}...`,
          { parse_mode: 'Markdown' }
        );

        const ok = await runExpirationAlertCheck(bot, true);
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
}
