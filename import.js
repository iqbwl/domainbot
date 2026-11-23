#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseDomainsCsv } from './lib/csv.js';
import { initDb, addOrUpdateDomain, getAllDomains, updateDomainWhois, getDomain } from './lib/db.js';
import { lookupDomain, calculateDaysLeft } from './lib/whois.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function syncAllDomains() {
  initDb();
  const domains = getAllDomains();
  if (domains.length === 0) {
    console.log('ℹ️ No domains found in database to sync.');
    return;
  }

  console.log(`\n🔄 Syncing WHOIS data for ${domains.length} domains...`);
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < domains.length; i++) {
    const d = domains[i];
    process.stdout.write(`[${i + 1}/${domains.length}] Checking ${d.domain}... `);
    try {
      const info = await lookupDomain(d.domain);
      if (info && info.expiredDate) {
        updateDomainWhois(d.domain, info);
        console.log(`✅ Exp: ${info.expiredDate} (${info.daysLeft}d left) [${info.source}]`);
        updated++;
      } else {
        console.log(`⚠️ Failed to parse WHOIS`);
        failed++;
      }
    } catch (err) {
      console.log(`❌ Error: ${err.message}`);
      failed++;
    }
    await sleep(600); // 600ms throttle
  }

  console.log(`\n==============================`);
  console.log(`📊 SYNC SUMMARY`);
  console.log(`==============================`);
  console.log(`✅ Updated : ${updated}`);
  console.log(`❌ Failed  : ${failed}`);
  console.log(`Total      : ${domains.length}`);
  console.log(`==============================\n`);
}

async function importCsv(filePath) {
  initDb();
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  const rawContent = fs.readFileSync(filePath, 'utf8');
  const { items, meta } = parseDomainsCsv(rawContent);

  if (items.length === 0) {
    console.log(`⚠️ No valid domains found in CSV.`);
    if (meta.error) console.log(`Issue: ${meta.error}`);
    if (meta.headers && meta.headers.length > 0) console.log(`Detected headers: ${meta.headers.join(', ')}`);
    return;
  }

  console.log(`\n📂 Found ${items.length} domains in ${path.basename(filePath)} (from ${meta.total} rows)`);
  if (meta.headers && meta.headers.length > 0) {
    console.log(`Detected headers: ${meta.headers.join(' | ')}`);
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const { domain, owner, registrar, expiredDate, registeredDate } = item;
    const existing = getDomain(domain);

    if (expiredDate) {
      const daysLeft = calculateDaysLeft(expiredDate);
      addOrUpdateDomain({
        domain,
        owner,
        registrar: registrar || (existing ? existing.registrar : 'Unknown'),
        registered_date: registeredDate || (existing ? existing.registered_date : null),
        expired_date: expiredDate,
        days_left: daysLeft
      });
      const tag = existing ? 'Updated' : 'New';
      console.log(`[${i + 1}/${items.length}] ✅ ${domain} (${owner}) -> Exp: ${expiredDate} (${daysLeft}d left) [${tag}]`);
      successCount++;
    } else if (existing && existing.expired_date) {
      // Domain already in DB with valid WHOIS data, just update owner / metadata without re-querying
      addOrUpdateDomain({
        domain,
        owner,
        registrar: registrar || existing.registrar,
        registered_date: registeredDate || existing.registered_date,
        expired_date: existing.expired_date,
        days_left: calculateDaysLeft(existing.expired_date)
      });
      console.log(`[${i + 1}/${items.length}] 🔄 ${domain} -> Exp: ${existing.expired_date} (${existing.days_left}d left) [Duplicate updated owner to "${owner}"]`);
      successCount++;
    } else {
      // Need WHOIS lookup
      process.stdout.write(`[${i + 1}/${items.length}] Querying WHOIS for ${domain} (${owner})... `);
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

        if (info.expiredDate) {
          console.log(`✅ Exp: ${info.expiredDate} (${info.daysLeft}d left) [${info.source}]`);
        } else {
          console.log(`⚠️ Saved, but WHOIS date not found`);
        }
        successCount++;
      } catch (err) {
        console.log(`❌ Error: ${err.message}`);
        failCount++;
      }

      await sleep(600); // polite rate limit
    }
  }

  console.log(`\n==============================`);
  console.log(`📊 IMPORT SUMMARY`);
  console.log(`==============================`);
  console.log(`✅ Imported/Updated : ${successCount}`);
  console.log(`❌ Failed           : ${failCount}`);
  console.log(`Total Processed     : ${items.length}`);
  console.log(`==============================\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(`
DomainBot Bulk Import & Sync Tool

Usage:
  node import.js <path_to_csv>    Import domains from CSV
  node import.js --sync           Re-query WHOIS for all domains in DB

CSV Format Example:
  domain,owner
  example.co.id,PT Contoh Teknologi Indonesia
  mycompany.com,Acme Corporation
    `);
    process.exit(0);
  }

  if (args[0] === '--sync') {
    await syncAllDomains();
  } else {
    await importCsv(args[0]);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
