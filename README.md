# DomainBot 🌐

Enterprise-grade Telegram bot for monitoring domain expirations, querying WHOIS/RDAP data, and delivering scheduled alerts directly to team groups, forum topics, and administrators.

---

## ✨ Features

- **Background Auto-Checker:** Continuous background worker queries live WHOIS/RDAP 1 domain every 12 seconds (`ORDER BY last_checked_at ASC`). Automatically detects domain renewals and keeps database records up-to-date 24/7 without manual intervention.
- **Non-Blocking Asynchronous Sync:** `/domain sync` runs detached in the background without blocking the Telegram event loop or queueing other users' commands.
- **Native Telegram Tables (Bot API 10.1):** Expiration alerts and `/domain expiring` queries render as real, interactive native Telegram tables (`sendRichMessage` / `RichBlockTable`) with borders and striped rows.
- **Daily Expiration Digest:** Scheduled daily alerts dispatch a comprehensive summary table of all domains nearing expiration or expired to designated groups/topics and administrator DMs.
- **Instant Telegram Document Export:** `/domain list` outputs a comprehensive, sorted `domains_DDMMYYYY_HHmm.md` snapshot file with local timezone timestamps (`WIB`).
- **Group-First Access Control:** Any member in authorized groups (`ALLOWED_GROUP_IDS`) can execute domain management commands. Direct messages (DM) to the bot are reserved exclusively for registered administrators (`ADMIN_IDS`) for CSV uploads and alert tests.
- **Clean & Professional English Interface:** Interactive commands, help menus, error messages, alert tables, and markdown exports are presented entirely in English with clear status badges (`🔴 EXPIRED`, `🚨 EXPIRES TODAY!`, `🔥 CRITICAL`, `⚠️ WARNING`, `🟡 NOTICE`, `✅ OK`).
- **In-Chat & CLI CSV Import:** Upload `.csv` files directly in Telegram chat (Admin DM) or run `node import.js file.csv` on the server.
- **Smart CSV Parsing Engine:** 
  - Automatically strips UTF-8 BOM headers (Excel Windows compatibility).
  - Auto-detects delimiters (comma `,`, semicolon `;`, or tab `\t`).
  - Fuzzy header matching (`domain`, `Domain Name`, `Nama Domain`, `owner`, `Client`, `expired`, etc.).
  - Auto-normalizes Indonesian and international date formats (`DD/MM/YYYY`, `DD-MM-YYYY`, `DD-MMM-YYYY`, `YYYY-MM-DD`).
- **Dual WHOIS & RDAP Engine:** Queries RDAP first (clean JSON) with Cloudflare-compatible User-Agent, falling back to authoritative TCP port 43 WHOIS (supporting global gTLDs and ccTLDs like `.id`, `.co.id`, `.net.id`, `.co`, `.asia`, `.nl`, etc.). Preserves exact registry/registrar dates without timezone shifting.
- **Flexible Multi-Word Owner Support:** Add and edit corporate owners without needing quotes (e.g. `/domain add example.co.id PT Contoh Teknologi Indonesia`).
- **Quick Owner Modification:** `/domain edit <domain> <new_owner>` updates client/company names in milliseconds without re-querying WHOIS.
- **Lightweight & Portable:** Powered by SQLite in WAL mode (`better-sqlite3`) for zero-configuration, lightning-fast storage.

---

## 📁 Project Structure

```text
domainbot/
├── lib/
│   ├── csv.js                # Smart CSV parser (BOM, fuzzy headers, date normalizer)
│   ├── db.js                 # SQLite schema, queries, and state management
│   ├── markdown.js           # Markdown report generator & native table formatter
│   └── whois.js              # RDAP & TCP port 43 WHOIS lookup engine
├── data/                     # CSV backups and uploaded files directory
├── domains.db                # SQLite database in WAL mode (auto-generated)
├── logs/                     # PM2 runtime and error logs
├── .env.example              # Configuration template
├── domains.example.csv       # Sample CSV format for bulk import
├── ecosystem.config.cjs      # PM2 production process configuration
├── import.js                 # Backend bulk import and sync CLI
├── index.js                  # Main GrammY bot runner, background worker, and scheduler
├── package.json              # Dependencies and scripts
└── README.md                 # Documentation
```

---

## 🚀 Setup & Installation (Fresh Server)

### 1. Prerequisites
- **Node.js:** `v22.x`, `v24.x`, or `v26.x` (>= 22.0.0 supported)
- **C++ Build Tools:** Required for `better-sqlite3` native compilation:
  - Debian/Ubuntu: `sudo apt-get install -y build-essential python3`
  - RHEL/CentOS: `sudo yum groupinstall "Development Tools" -y`
- **PM2:** `npm install -g pm2`

### 2. Clone & Install Dependencies
```bash
git clone <your-repo-url> domainbot
cd domainbot
npm install
```

> **Note on Node version mismatch:** If you switch Node.js versions via NVM, rebuild native addons:
> ```bash
> npm rebuild better-sqlite3
> ```

### 3. Configure Environment
```bash
cp .env.example .env
nano .env
```

| Key | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `BOT_TOKEN` | **Yes** | Telegram Bot Token from `@BotFather` | `123456789:ABCdefGh...` |
| `ADMIN_IDS` | **Yes** | Telegram User IDs authorized for administrative DM tasks | `123456789` |
| `ALLOWED_GROUP_IDS` | No | Group IDs where group members can use the bot | `-1001234567890` |
| `ALERT_CHAT_ID` | No | Target Chat ID for daily alerts (Group or Admin ID) | `-1001234567890` |
| `ALERT_THREAD_ID` | No | Forum Topic ID (`message_thread_id`) for group alerts | `1142` |
| `ALERT_CRON` | No | Daily alert cron schedule (Default: `0 8 * * *` / 08:00 AM) | `0 8 * * *` |
| `ALERT_THRESHOLDS` | No | Day thresholds for alerts (Descending) | `60,30,14,7,3,1,0` |
| `BACKGROUND_CHECK_INTERVAL_MS` | No | Interval for background worker in ms (Default: `12000`) | `12000` |
| `TIMEZONE` | No | Timezone for alerts and reports | `Asia/Jakarta` |

---

## 🤖 Telegram Commands

Within authorized groups (`ALLOWED_GROUP_IDS`), **all group members** can use all domain management commands. Direct messages (DM) to the bot are restricted to registered administrators (`ADMIN_IDS`) for maintenance and security (bulk CSV import and alert dispatch testing).

| Command | Description |
| :--- | :--- |
| `/start` | Display bot instructions, access guide, and available commands |
| `/domain` / `/domain help` | Display bot instructions and available commands |
| `/domain list` | Export a dated `.md` snapshot report file with complete status table |
| `/domain add <domain> <owner>` | Register a domain to monitoring with automatic WHOIS check |
| `/domain edit <domain> <new_owner>` | Instantly update domain owner/client name |
| `/domain delete <domain>` | Remove a domain from monitoring list |
| `/domain check <domain>` | Realtime WHOIS/RDAP check without storing in database |
| `/domain expiring [days]` | Show table & send `.md` report of domains expiring within $\le$ N days (default: 30) |
| `/domain sync` | Trigger bulk WHOIS sync in the detached background (non-blocking) |
| `/domain testalert` | Dispatch a test alert to target group/topic (Admin DM only) |

---

## 📥 Importing Domains

### Option A: Via Telegram Chat (Admin DM Only)
Attach and send any `.csv` file directly to the bot in a **Private Chat (DM)** with an authorized admin. For data safety, the bot automatically ignores CSV files uploaded in groups. The bot will automatically:
1. Parse columns using fuzzy matching.
2. Normalize date formats.
3. Perform WHOIS lookups for domains lacking expiration dates.
4. Deduplicate (UPSERT) existing records.
5. Report total processed, new domains, duplicates updated, and failures.

### Option B: Via Terminal CLI
```bash
# Simple import (auto-queries WHOIS for missing dates)
node import.js domains.csv

# Force WHOIS re-sync across all records in DB
node import.js --sync
```

Sample CSV format (`domains.example.csv`):
```csv
domain,owner,registrar,registered_date,expired_date
example.co.id,PT Contoh Teknologi Indonesia,Registrar Partner,2022-05-23,2027-05-23
mycompany.com,Acme Corporation,Example Registrar LLC,2020-01-15,2026-09-28
```

---

## ⚙️ Running 24/7 with PM2

Start the bot service:
```bash
pm2 start ecosystem.config.cjs
pm2 save
```

Service management:
```bash
pm2 logs domainbot      # View live logs
pm2 restart domainbot   # Restart bot
pm2 stop domainbot      # Stop service
```

---

## 🔒 Security & Git Hygiene

The `.gitignore` is pre-configured to strictly exclude:
- Environment secrets (`.env`, `.env.*`)
- SQLite database files (`*.db`, `*.db-wal`, `*.db-shm`, `data/`)
- User uploaded files (`data/uploads/`, `*.csv`)
- Log files (`logs/`, `*.log`)

Never commit `.env` or production database files to public or shared repositories.
