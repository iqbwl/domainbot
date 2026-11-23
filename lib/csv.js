import { parse } from 'csv-parse/sync';

export function normalizeDate(str) {
  if (!str) return null;
  let s = String(str).trim();
  if (!s || s === '-' || s.toLowerCase() === 'null' || s.toLowerCase() === 'n/a') return null;

  const idMonths = {
    'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04', 'mei': '05', 'may': '05',
    'jun': '06', 'jul': '07', 'agu': '08', 'aug': '08', 'agt': '08', 'sep': '09',
    'okt': '10', 'oct': '10', 'nov': '11', 'des': '12', 'dec': '12'
  };

  // 1. Check YYYY-MM-DD or YYYY/MM/DD
  let m1 = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m1) {
    return `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`;
  }

  // 2. Check DD/MM/YYYY or DD-MM-YYYY
  let m2 = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m2) {
    return `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  }

  // 3. Check DD-Mon-YYYY or DD Mon YYYY (e.g. 16 Sep 2026, 16-Agu-2026)
  let m3 = s.match(/^(\d{1,2})[-/\s]([a-zA-Z]{3,})[-/\s](\d{4})/);
  if (m3) {
    const day = m3[1].padStart(2, '0');
    const monKey = m3[2].toLowerCase().substring(0, 3);
    const month = idMonths[monKey];
    const year = m3[3];
    if (month) return `${year}-${month}-${day}`;
  }

  // 4. Standard JS date fallback
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString().split('T')[0];
  }
  return null;
}

export function parseDomainsCsv(csvText) {
  if (!csvText || !csvText.trim()) {
    return { items: [], meta: { total: 0, headers: [], error: 'CSV file is empty' } };
  }

  let rawRows;
  try {
    rawRows = parse(csvText, {
      skip_empty_lines: true,
      trim: true,
      bom: true,
      delimiter: [',', ';', '\t']
    });
  } catch (err) {
    return { items: [], meta: { total: 0, headers: [], error: `CSV parser error: ${err.message}` } };
  }

  if (!rawRows || rawRows.length === 0) {
    return { items: [], meta: { total: 0, headers: [], error: 'CSV file contains no rows' } };
  }

  let headerRow = rawRows[0];
  let dataRows = rawRows.slice(1);

  const firstCell = (headerRow[0] || '').toLowerCase().trim();
  const looksLikeDomain = /[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(firstCell) && !firstCell.includes('domain');

  let domainIdx = -1;
  let ownerIdx = -1;
  let registrarIdx = -1;
  let expIdx = -1;
  let regIdx = -1;

  if (looksLikeDomain) {
    // No header detected; all rows are data
    domainIdx = 0;
    ownerIdx = headerRow.length > 1 ? 1 : -1;
    expIdx = headerRow.length > 2 ? 2 : -1;
    dataRows = rawRows;
  } else {
    // Header detection by common keywords
    for (let i = 0; i < headerRow.length; i++) {
      const h = (headerRow[i] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (domainIdx === -1 && (h.includes('domain') || h === 'hostname' || h === 'url' || h === 'site')) {
        domainIdx = i;
      } else if (ownerIdx === -1 && (
        h.includes('owner') || h.includes('client') || h.includes('klien') ||
        h.includes('customer') || h.includes('company') || h.includes('pelanggan') ||
        h.includes('perusahaan') || h === 'nama' || h === 'name'
      )) {
        ownerIdx = i;
      } else if (registrarIdx === -1 && (h.includes('registrar') || h.includes('provider') || h.includes('vendor'))) {
        registrarIdx = i;
      } else if (expIdx === -1 && (
        h.includes('expire') || h.includes('expiry') || h.includes('exp') ||
        h.includes('berakhir') || h.includes('duedate') || h.includes('enddate') ||
        h.includes('tglhabis') || h.includes('jatuhtempo')
      )) {
        expIdx = i;
      } else if (regIdx === -1 && (
        h.includes('register') || h.includes('creation') || h.includes('created') ||
        h.includes('startdate') || h.includes('tgldaftar')
      )) {
        regIdx = i;
      }
    }

    // Fallback: if domainIdx still not found, search columns in the first data row for domain pattern
    if (domainIdx === -1 && dataRows.length > 0) {
      for (let i = 0; i < dataRows[0].length; i++) {
        if (/[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(dataRows[0][i])) {
          domainIdx = i;
          break;
        }
      }
    }
  }

  if (domainIdx === -1) {
    return {
      items: [],
      meta: {
        total: dataRows.length,
        headers: looksLikeDomain ? [] : headerRow,
        error: 'Unable to detect a column containing domain names. Please make sure there is a "Domain" column.'
      }
    };
  }

  const items = [];
  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r];
    let rawDomain = row[domainIdx] || '';
    let domain = String(rawDomain)
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^[^\w]+|[^\w]+$/g, '');

    if (!domain || !domain.includes('.') || domain.length < 3) continue;

    let owner = ownerIdx !== -1 && row[ownerIdx] ? String(row[ownerIdx]).trim() : 'Unknown';
    let registrar = registrarIdx !== -1 && row[registrarIdx] ? String(row[registrarIdx]).trim() : null;
    let expiredDate = expIdx !== -1 && row[expIdx] ? normalizeDate(row[expIdx]) : null;
    let registeredDate = regIdx !== -1 && row[regIdx] ? normalizeDate(row[regIdx]) : null;

    items.push({
      domain,
      owner: owner || 'Unknown',
      registrar: registrar || null,
      expiredDate,
      registeredDate
    });
  }

  return {
    items,
    meta: {
      total: dataRows.length,
      headers: looksLikeDomain ? [] : headerRow,
      domainIdx,
      ownerIdx,
      expIdx,
      registrarIdx
    }
  };
}
