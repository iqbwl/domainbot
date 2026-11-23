import net from 'node:net';

// Map common TLDs to authoritative port 43 WHOIS servers
const WHOIS_SERVERS = {
  'id': 'whois.id',
  'co.id': 'whois.id',
  'net.id': 'whois.id',
  'web.id': 'whois.id',
  'my.id': 'whois.id',
  'or.id': 'whois.id',
  'ac.id': 'whois.id',
  'sch.id': 'whois.id',
  'biz.id': 'whois.id',
  'com': 'whois.verisign-grs.com',
  'net': 'whois.verisign-grs.com',
  'org': 'whois.pir.org',
  'info': 'whois.afilias.net',
  'biz': 'whois.biz',
  'xyz': 'whois.nic.xyz',
  'io': 'whois.nic.io',
  'co': 'whois.registry.co',
  'me': 'whois.nic.me',
  'ai': 'whois.nic.ai',
  'asia': 'whois.nic.asia',
  'nl': 'whois.domain-registry.nl',
  'co.nl': 'whois.co.nl',
  'co.com': 'whois.nic.co.com',
  'tours': 'whois.nic.tours',
  'education': 'whois.nic.education',
  'cc': 'whois.nic.cc',
  'tv': 'whois.nic.tv',
  'us': 'whois.nic.us',
  'uk': 'whois.nic.uk',
  'co.uk': 'whois.nic.uk',
  'de': 'whois.denic.de',
  'jp': 'whois.jprs.jp',
  'sg': 'whois.sgnic.sg',
  'au': 'whois.auda.org.au'
};

function getWhoisServer(domain) {
  const parts = domain.toLowerCase().split('.');
  if (parts.length >= 3) {
    const secondLevel = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (WHOIS_SERVERS[secondLevel]) return WHOIS_SERVERS[secondLevel];
  }
  const tld = parts[parts.length - 1];
  return WHOIS_SERVERS[tld] || `whois.nic.${tld}`;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (!s || s === '-' || s.toLowerCase() === 'null') return null;

  // 1. Literal YYYY-MM-DD or YYYY/MM/DD (preserves exact date from WHOIS/RDAP)
  const mYmd = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (mYmd) {
    return `${mYmd[1]}-${mYmd[2].padStart(2, '0')}-${mYmd[3].padStart(2, '0')}`;
  }

  // 2. Literal DD-MM-YYYY or DD/MM/YYYY
  const mDmy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (mDmy) {
    return `${mDmy[3]}-${mDmy[2].padStart(2, '0')}-${mDmy[1].padStart(2, '0')}`;
  }

  // 3. Literal DD-Mon-YYYY (e.g. 25-Nov-2026, 25 Nov 2026)
  const idMonths = {
    'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04', 'mei': '05', 'may': '05',
    'jun': '06', 'jul': '07', 'agu': '08', 'aug': '08', 'agt': '08', 'sep': '09',
    'okt': '10', 'oct': '10', 'nov': '11', 'des': '12', 'dec': '12'
  };
  const mMon = s.match(/^(\d{1,2})[-/\s]([a-zA-Z]{3,})[-/\s](\d{4})/);
  if (mMon) {
    const day = mMon[1].padStart(2, '0');
    const monKey = mMon[2].toLowerCase().substring(0, 3);
    const month = idMonths[monKey];
    const year = mMon[3];
    if (month) return `${year}-${month}-${day}`;
  }

  // 4. Fallback: Parse ISO timestamp using UTC date (never shifts forward due to local timezone)
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString().split('T')[0];
  }

  return null;
}

export function calculateDaysLeft(expiredDateStr, timezone = 'Asia/Jakarta') {
  if (!expiredDateStr) return null;
  const nowParts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  const expDateOnly = expiredDateStr.split('T')[0].trim();
  const [y1, m1, d1] = nowParts.split('-').map(Number);
  const [y2, m2, d2] = expDateOnly.split(/[-/]/).map(Number);
  if (isNaN(y1) || isNaN(y2) || isNaN(m2) || isNaN(d2)) return null;
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / (1000 * 60 * 60 * 24));
}

// Google Registry TLDs (authoritative RDAP endpoint)
const GOOGLE_REGISTRY_TLDS = new Set(['dev', 'app', 'page', 'how', 'soy', 'chrome', 'boo', 'day', 'new', 'rsvp']);

export function getRdapUrl(domain) {
  const cleanDomain = domain.toLowerCase().trim();
  const parts = cleanDomain.split('.');
  const tld = parts[parts.length - 1];

  if (GOOGLE_REGISTRY_TLDS.has(tld)) {
    return `https://pubapi.registry.google/rdap/domain/${encodeURIComponent(cleanDomain)}`;
  }

  return `https://rdap.org/domain/${encodeURIComponent(cleanDomain)}`;
}

// 1. Query via RDAP (Preferred: clean JSON)
export async function queryRdap(domain) {
  const cleanDomain = domain.toLowerCase().trim();
  const primaryUrl = getRdapUrl(cleanDomain);

  const urlsToTry = [primaryUrl];
  const genericUrl = `https://rdap.org/domain/${encodeURIComponent(cleanDomain)}`;
  if (primaryUrl !== genericUrl) {
    urlsToTry.push(genericUrl);
  }

  for (const url of urlsToTry) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/rdap+json, application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 DomainBot/1.0'
        }
      });
      clearTimeout(timeout);

      if (!res.ok) {
        continue;
      }

      const data = await res.json();
      let registeredDate = null;
      let expiredDate = null;
      let registrar = null;

      // Parse events for registration and expiration dates
      if (Array.isArray(data.events)) {
        for (const ev of data.events) {
          const action = (ev.eventAction || '').toLowerCase();
          if (['registration', 'registered', 'created'].includes(action)) {
            registeredDate = formatDate(ev.eventDate);
          } else if (['expiration', 'soft expiration', 'expiry'].includes(action)) {
            expiredDate = formatDate(ev.eventDate);
          }
        }
      }

      // Parse entities for registrar
      if (Array.isArray(data.entities)) {
        const regEntity = data.entities.find(e => 
          Array.isArray(e.roles) && e.roles.some(r => ['registrar', 'sponsor', 'sponsoring registrar'].includes(r.toLowerCase()))
        );
        if (regEntity) {
          if (Array.isArray(regEntity.vcardArray) && Array.isArray(regEntity.vcardArray[1])) {
            const fnCard = regEntity.vcardArray[1].find(item => item[0] === 'fn');
            if (fnCard && fnCard[3]) {
              registrar = fnCard[3];
            }
          }
          if (!registrar && regEntity.handle) {
            registrar = regEntity.handle;
          }
        }
      }

      if (expiredDate) {
        return {
          domain: cleanDomain,
          registrar: registrar || 'Unknown',
          registeredDate,
          expiredDate,
          daysLeft: calculateDaysLeft(expiredDate),
          source: 'RDAP'
        };
      }
    } catch (err) {
      // Continue to next URL fallback
    }
  }

  return null;
}

// 2. Query via Port 43 TCP WHOIS (Fallback)
export function queryWhoisTcp(domain, server, port = 43, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let host = server;
    if (!host) {
      host = getWhoisServer(domain) || 'whois.iana.org';
    }

    const client = net.createConnection({ host, port }, () => {
      client.write(`${domain.trim()}\r\n`);
    });

    let raw = '';
    client.setTimeout(timeoutMs);

    client.on('data', chunk => {
      raw += chunk.toString('utf8');
    });

    client.on('end', () => {
      resolve(raw);
    });

    client.on('timeout', () => {
      client.destroy();
      reject(new Error(`Connection to ${host}:${port} timed out`));
    });

    client.on('error', err => {
      reject(err);
    });
  });
}

export function parseWhoisText(domain, raw) {
  let registeredDate = null;
  let expiredDate = null;
  let registrar = null;

  const lines = raw.split('\n');
  for (let line of lines) {
    line = line.trim();
    const lower = line.toLowerCase();

    // Registrar
    if (!registrar) {
      const mReg = line.match(/^(?:Registrar|Sponsoring Registrar|Registrar Name):\s*(.+)$/i);
      if (mReg && mReg[1] && !mReg[1].toLowerCase().includes('whois server')) {
        registrar = mReg[1].trim();
      }
    }

    // Expiration date
    if (!expiredDate) {
      const mExp = line.match(/^(?:Registry Expiry Date|Registrar Registration Expiration Date|Expiration Date|Expiry Date|Registry Expiry|paid-till):\s*(.+)$/i);
      if (mExp && mExp[1]) {
        expiredDate = formatDate(mExp[1].trim());
      }
    }

    // Registered date
    if (!registeredDate) {
      const mReg = line.match(/^(?:Creation Date|Created On|Registered On|Registration Date|created):\s*(.+)$/i);
      if (mReg && mReg[1]) {
        registeredDate = formatDate(mReg[1].trim());
      }
    }
  }

  return {
    domain: domain.toLowerCase().trim(),
    registrar: registrar || 'Unknown',
    registeredDate,
    expiredDate,
    daysLeft: calculateDaysLeft(expiredDate),
    source: 'WHOIS'
  };
}

// Master lookup: tries RDAP first, then WHOIS TCP
export async function lookupDomain(domain) {
  const cleanDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  // 1. Try RDAP
  const rdapRes = await queryRdap(cleanDomain);
  if (rdapRes && rdapRes.expiredDate) {
    return rdapRes;
  }

  // 2. Fallback to TCP WHOIS
  let whoisRes = null;
  try {
    const raw = await queryWhoisTcp(cleanDomain);
    whoisRes = parseWhoisText(cleanDomain, raw);
    if (whoisRes && whoisRes.expiredDate) {
      return whoisRes;
    }
  } catch (err) {
    // If specific server failed or timed out
  }

  // Return best effort
  if (rdapRes && (rdapRes.expiredDate || rdapRes.registrar !== 'Unknown')) {
    return rdapRes;
  }
  if (whoisRes && (whoisRes.expiredDate || whoisRes.registrar !== 'Unknown')) {
    return whoisRes;
  }
  return rdapRes || whoisRes || {
    domain: cleanDomain,
    registrar: 'Unknown',
    registeredDate: null,
    expiredDate: null,
    daysLeft: null,
    source: 'Failed'
  };
}
