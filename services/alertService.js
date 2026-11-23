import cron from 'node-cron';
import { config } from '../config.js';
import { getAllDomains, updateDomainWhois, updateAlertState } from '../lib/db.js';
import { calculateDaysLeft } from '../lib/whois.js';
import { formatNativeAlertTable } from '../lib/markdown.js';
import { sendRichOrPlain } from '../lib/telegram.js';

export async function runExpirationAlertCheck(bot, isTest = false) {
  console.log('⏰ Running domain expiration alert check...');
  const domains = getAllDomains('days_left ASC');

  // Delivery destinations (Group/Topic + Admin DMs)
  const destinations = [];
  if (config.alertChatId) {
    const opts = { parse_mode: 'Markdown' };
    if (config.alertThreadId && !isNaN(config.alertThreadId)) {
      opts.message_thread_id = config.alertThreadId;
    }
    destinations.push({ chatId: config.alertChatId, options: opts, type: 'ALERT_CHAT' });
  }

  for (const adminId of config.adminIds) {
    if (String(adminId) !== String(config.alertChatId)) {
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
        await sendRichOrPlain(bot, dest.chatId, msg, dest.options);
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
        `Daily alert schedule: \`${config.alertCron}\``;
      return await sendToAll(testMsg);
    }
    return true;
  }

  // Recalculate latest daysLeft for all domains & collect domains nearing expiration
  const maxThreshold = config.alertThresholds.length > 0 ? Math.max(...config.alertThresholds) : 60;
  const alerts = [];

  for (const d of domains) {
    if (!d.expired_date) continue;
    const currentDays = calculateDaysLeft(d.expired_date, config.timezone);

    updateDomainWhois(d.domain, {
      registrar: d.registrar,
      registeredDate: d.registered_date,
      expiredDate: d.expired_date,
      daysLeft: currentDays
    });

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
        `Daily alert schedule: \`${config.alertCron}\``;
      return await sendToAll(testMsg);
    }
    console.log('✅ Alert check completed. All domains are healthy.');
    return true;
  }

  alerts.sort((a, b) => a.daysLeft - b.daysLeft);

  const tz = config.timezone;
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
  alertMsg += formatNativeAlertTable(alerts);
  alertMsg += `\n---\n_Type \`/domain list\` to download the complete report file._`;

  return await sendToAll(alertMsg);
}

let cronTask = null;

export function startAlertScheduler(bot) {
  cronTask = cron.schedule(config.alertCron, () => {
    runExpirationAlertCheck(bot).catch(err => {
      console.error('Error running daily alert check:', err);
    });
  }, {
    timezone: config.timezone
  });

  console.log(`⏰ Daily cron alert active with pattern: "${config.alertCron}" (Timezone: ${config.timezone})`);
}

export function stopAlertScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
