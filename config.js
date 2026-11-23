import 'dotenv/config';

// Validate BOT_TOKEN
const token = process.env.BOT_TOKEN;
if (!token || token.trim() === '' || token === 'YOUR_TELEGRAM_BOT_TOKEN') {
  console.error('❌ ERROR: BOT_TOKEN is not defined in .env file.');
  process.exit(1);
}

export const config = {
  token,
  adminIds: new Set(
    (process.env.ADMIN_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number)
  ),
  allowedGroupIds: new Set(
    (process.env.ALLOWED_GROUP_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(id => id.startsWith('-') ? Number(id) : Number(`-${id}`))
  ),
  alertChatId: process.env.ALERT_CHAT_ID ? process.env.ALERT_CHAT_ID.trim() : null,
  alertThreadId: process.env.ALERT_THREAD_ID ? parseInt(process.env.ALERT_THREAD_ID.trim(), 10) : null,
  alertCron: process.env.ALERT_CRON || '0 8 * * *',
  alertThresholds: (process.env.ALERT_THRESHOLDS || '60,30,14,7,3,1,0')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n))
    .sort((a, b) => b - a),
  backgroundCheckIntervalMs: parseInt(process.env.BACKGROUND_CHECK_INTERVAL_MS || '12000', 10),
  timezone: process.env.TIMEZONE || 'Asia/Jakarta'
};
