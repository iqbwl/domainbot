import { calculateDaysLeft } from './whois.js';

export function generateDomainsMarkdown(domains, timezone = 'Asia/Jakarta', options = {}) {
  const dParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date());

  const day = dParts.find(p => p.type === 'day')?.value || '01';
  const month = dParts.find(p => p.type === 'month')?.value || '01';
  const year = dParts.find(p => p.type === 'year')?.value || '2026';
  const hour = dParts.find(p => p.type === 'hour')?.value || '00';
  const minute = dParts.find(p => p.type === 'minute')?.value || '00';
  const second = dParts.find(p => p.type === 'second')?.value || '00';

  const tzSuffix = timezone === 'Asia/Jakarta' ? 'WIB' : timezone;
  const dateStr = `${year}-${month}-${day} ${hour}:${minute}:${second} ${tzSuffix}`;

  // Dynamically recalculate days_left against current date in timezone
  const dynamicDomains = domains.map(d => {
    if (!d.expired_date) return d;
    return { ...d, days_left: calculateDaysLeft(d.expired_date, timezone) };
  });

  dynamicDomains.sort((a, b) => {
    if (a.days_left === null && b.days_left === null) return 0;
    if (a.days_left === null) return 1;
    if (b.days_left === null) return -1;
    return a.days_left - b.days_left;
  });

  const total = dynamicDomains.length;
  const expiredCount = dynamicDomains.filter(d => d.days_left !== null && d.days_left <= 0).length;
  const urgentCount = dynamicDomains.filter(d => d.days_left !== null && d.days_left > 0 && d.days_left <= 30).length;
  const safeCount = total - expiredCount - urgentCount;

  const title = options.title || '# 🌐 Domain Monitoring Report';
  let md = `${title}\n\n`;
  if (options.daysThreshold) {
    md += `> **Filter:** Domains expiring within ≤ ${options.daysThreshold} days  \n`;
  }
  md += `> **Generated at:** \`${dateStr}\`\n\n`;
  md += `### 📊 Summary Overview\n`;
  md += `- **Total Monitored Domains:** \`${total}\`\n`;
  if (expiredCount > 0) {
    md += `- **🔴 Expired:** \`${expiredCount}\`\n`;
  }
  md += `- **⚠️ Expiring Soon (≤ 30 Days):** \`${urgentCount}\`\n`;
  if (!options.daysThreshold) {
    md += `- **✅ Healthy (> 30 Days):** \`${safeCount}\`\n`;
  }
  md += `\n---\n\n`;

  md += `## 📋 Monitored Domains List\n\n`;
  md += `| Domain | Owner | Registrar | Registered | Expired | Status & Days Left |\n`;
  md += `| :--- | :--- | :--- | :---: | :---: | :---: |\n`;

  if (dynamicDomains.length === 0) {
    md += `| *(No domains added yet)* | - | - | - | - | - |\n`;
  } else {
    for (const d of dynamicDomains) {
      const domain = d.domain;
      const owner = (d.owner || '-').replace(/\|/g, '-').trim();
      const registrar = (d.registrar || 'Unknown').replace(/\|/g, '-').trim();
      const regDate = d.registered_date || '-';
      const expDate = d.expired_date || '-';

      let statusBadge = '-';
      if (d.days_left !== null) {
        if (d.days_left < 0) {
          statusBadge = `🔴 EXPIRED (${Math.abs(d.days_left)}d ago)`;
        } else if (d.days_left === 0) {
          statusBadge = `🚨 EXPIRES TODAY!`;
        } else if (d.days_left <= 7) {
          statusBadge = `🔥 CRITICAL (${d.days_left}d)`;
        } else if (d.days_left <= 30) {
          statusBadge = `⚠️ WARNING (${d.days_left}d)`;
        } else if (d.days_left <= 60) {
          statusBadge = `🟡 NOTICE (${d.days_left}d)`;
        } else {
          statusBadge = `✅ OK (${d.days_left}d)`;
        }
      }

      md += `| \`${domain}\` | ${owner} | ${registrar} | ${regDate} | ${expDate} | ${statusBadge} |\n`;
    }
  }

  md += `\n---\n`;
  md += `*Generated automatically by DomainBot*\n`;

  return md;
}

export function formatNativeAlertTable(alerts, maxRows = 50) {
  if (!alerts || alerts.length === 0) return '';
  const displayAlerts = alerts.slice(0, maxRows);

  let md = `| Domain | Owner | Expiration | Status |\n`;
  md += `|:---|:---|:---:|:---:|\n`;

  for (const a of displayAlerts) {
    let status = '';
    if (a.daysLeft < 0) status = `🔴 *${Math.abs(a.daysLeft)}d ago*`;
    else if (a.daysLeft === 0) status = `🚨 *TODAY*`;
    else if (a.daysLeft <= 7) status = `🔥 *${a.daysLeft}d*`;
    else if (a.daysLeft <= 30) status = `⚠️ *${a.daysLeft}d*`;
    else status = `🟡 *${a.daysLeft}d*`;

    const owner = (a.owner || '-').replace(/\|/g, '-').trim();
    const domain = a.domain;
    const exp = a.expiredDate || '-';
    md += `| *${domain}* | ${owner} | \`${exp}\` | ${status} |\n`;
  }

  if (alerts.length > maxRows) {
    md += `\n*... and ${alerts.length - maxRows} more domains.*`;
  }
  return md;
}
