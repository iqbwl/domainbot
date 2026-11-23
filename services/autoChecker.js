import { getNextDomainToCheck, updateDomainWhois, touchDomainChecked } from '../lib/db.js';
import { lookupDomain } from '../lib/whois.js';
import { syncState } from './syncState.js';
import { config } from '../config.js';

let isBackgroundChecking = false;

export async function runBackgroundAutoCheck() {
  if (isBackgroundChecking || syncState.isSyncing) return;
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

let timer = null;

export function startAutoChecker() {
  if (timer) return;
  timer = setInterval(() => {
    runBackgroundAutoCheck().catch(() => {});
  }, config.backgroundCheckIntervalMs);
}

export function stopAutoChecker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
