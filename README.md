# DomainBot

Telegram bot to monitor domain expiration dates via RDAP/WHOIS, deliver scheduled expiration alerts, and manage domain records.

## Features

- **WHOIS & RDAP Engine:** Queries RDAP first, falling back to authoritative port 43 TCP WHOIS for global gTLDs and ccTLDs.
- **Background Auto-Checker:** Sequentially checks domains in the background to automatically detect renewals without manual intervention.
- **Scheduled Expiration Alerts:** Dispatches daily summaries of domains nearing expiration to designated groups, forum topics, or admin DMs.
- **Report Export:** Generates downloadable `.md` snapshot reports with status breakdown and days remaining.
- **CSV Bulk Import:** Import domains directly in Telegram (Admin DM) or via server CLI (`node import.js`).
- **SQLite Storage:** Lightweight zero-configuration storage in WAL mode powered by `better-sqlite3`.

## Project Structure

```text
domainbot/
├── config.js                 # Environment and application configuration
├── handlers/
│   ├── commands.js           # Telegram bot command handlers (/start, /domain)
│   └── upload.js             # CSV document upload and deduplication handler
├── services/
│   ├── alertService.js       # Daily expiration alert job and cron scheduler
│   ├── autoChecker.js        # Background continuous WHOIS auto-checker worker
│   └── syncState.js          # Shared synchronization state controller
├── lib/
│   ├── csv.js                # CSV parser and date normalizer
│   ├── db.js                 # SQLite schema, queries, and connection lifecycle
│   ├── markdown.js           # Markdown report generator and table formatter
│   ├── telegram.js           # Telegram formatting and permission helpers
│   └── whois.js              # RDAP and TCP port 43 WHOIS lookup engine
├── data/                     # Uploaded files and backup directory
├── domains.db                # SQLite database in WAL mode (auto-generated)
├── logs/                     # PM2 runtime and error logs
├── .env.example              # Configuration template
├── domains.example.csv       # Sample CSV format for bulk import
├── ecosystem.config.cjs      # PM2 process configuration
├── import.js                 # Backend bulk import CLI
├── index.js                  # Application entry point
├── package.json              # Dependencies and scripts
└── README.md                 # Documentation
```

## Requirements

- Node.js >= 22 (`v22.x`, `v24.x`, or `v26.x`)
- C++ build tools (required for `better-sqlite3` native build if not using prebuilt binary):
  - Debian/Ubuntu: `sudo apt-get install -y build-essential python3`
- PM2 (optional, for daemonized production running)

## Installation

1. Clone repository:
   ```bash
   git clone <repo-url> domainbot
   cd domainbot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment:
   ```bash
   cp .env.example .env
   nano .env
   ```

## Configuration

| Variable | Required | Description | Default / Example |
| :--- | :---: | :--- | :--- |
| `BOT_TOKEN` | Yes | Telegram Bot Token from `@BotFather` | `123456789:ABCdefGh...` |
| `ADMIN_IDS` | Yes | Authorized Telegram User IDs (comma-separated) | `123456789` |
| `ALLOWED_GROUP_IDS` | No | Allowed Group IDs (leave blank for any group) | `-1001234567890` |
| `ALERT_CHAT_ID` | No | Destination chat for daily alerts (Group or Admin ID) | `-1001234567890` |
| `ALERT_THREAD_ID` | No | Topic ID (`message_thread_id`) if `ALERT_CHAT_ID` is a forum | `1142` |
| `ALERT_CRON` | No | Cron schedule for daily alert | `0 8 * * *` (08:00 AM) |
| `ALERT_THRESHOLDS` | No | Days-before-expiration alert trigger thresholds | `60,30,14,7,3,1,0` |
| `BACKGROUND_CHECK_INTERVAL_MS` | No | Interval for sequential background WHOIS check (ms) | `12000` |
| `TIMEZONE` | No | Timezone for reports and scheduling | `Asia/Jakarta` |

## Telegram Commands

Group members in authorized groups can run domain commands. Sensitive actions (CSV upload, alert test) are restricted to admin private chat (DM).

| Command | Description |
| :--- | :--- |
| `/start` | Show help and list of available commands |
| `/domain` / `/domain help` | Display bot usage guide |
| `/domain list` | Export dated `.md` snapshot report with complete domain table |
| `/domain add <domain> <owner>` | Add domain to monitoring with live WHOIS lookup |
| `/domain edit <domain> <owner>` | Update registered owner for an existing domain |
| `/domain delete <domain>` | Remove domain from monitoring database |
| `/domain check <domain>` | Query live WHOIS/RDAP without saving to database |
| `/domain expiring [days]` | Show domains expiring within N days (default: 30) and attach `.md` report |
| `/domain sync` | Trigger bulk WHOIS sync in the background |
| `/domain testalert` | Send test alert notification to destination chat (Admin DM only) |

## CSV Import

### Via Telegram (Admin DM)
Send a `.csv` file directly to the bot in a private chat. The bot will parse columns, normalize dates, look up missing WHOIS data, and deduplicate records.

### Via Terminal CLI
```bash
# Bulk import from CSV
node import.js domains.csv

# Force sync all existing domains in database
node import.js --sync
```

Sample CSV format (`domains.example.csv`):
```csv
domain,owner
example.co.id,Acme Corporation
mycompany.com,Example Global Inc
```

## Running with PM2

```bash
# Start bot
pm2 start ecosystem.config.cjs
pm2 save

# Logs and management
pm2 logs domainbot
pm2 restart domainbot
pm2 stop domainbot
```

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
