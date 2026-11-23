import { Bot } from 'grammy';
import { config } from './config.js';
import { initDb, closeDb } from './lib/db.js';
import { registerCommands } from './handlers/commands.js';
import { registerUploadHandler } from './handlers/upload.js';
import { startAutoChecker, stopAutoChecker } from './services/autoChecker.js';
import { startAlertScheduler, stopAlertScheduler } from './services/alertService.js';
import { isAdmin } from './lib/telegram.js';

// 1. Initialize Database
initDb();
console.log('✅ SQLite Database connected and initialized.');

// 2. Initialize GrammY Bot
const bot = new Bot(config.token);

// 3. Global Access Control Middleware
bot.use(async (ctx, next) => {
  const chatType = ctx.chat?.type;
  const chatId = ctx.chat?.id;

  // In private chat: only registered admins are allowed
  if (chatType === 'private') {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ *Access Denied*\nThis bot can only be used within authorized groups.', { parse_mode: 'Markdown' });
      return;
    }
  } else if (chatType === 'group' || chatType === 'supergroup') {
    // In group: verify allowed group if specified
    if (config.allowedGroupIds.size > 0 && !config.allowedGroupIds.has(chatId)) {
      return; // Ignore silently in unauthorized groups
    }
  }

  await next();
});

// 4. Register Command and Upload Handlers
registerCommands(bot);
registerUploadHandler(bot);

// 5. Start Background Workers and Scheduler
startAutoChecker();
startAlertScheduler(bot);

// 6. Error and Rejection Handling
bot.catch((err) => {
  console.error('Error in bot middleware:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (String(reason).includes('getUpdates') || String(reason).includes('409') || String(reason).includes('GrammyError')) {
    console.error('Fatal Telegram polling error detected. Exiting for PM2 restart...');
    process.exit(1);
  }
});

// 7. Graceful Shutdown
function shutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  stopAutoChecker();
  stopAlertScheduler();
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 8. Start GrammY Polling
async function start() {
  console.log('Mendaftarkan bot commands di Telegram...');
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Show help and list of available commands' },
      { command: 'domain', description: 'Manage and monitor domain expirations' },
    ]);
    console.log('Bot commands berhasil didaftarkan.');
  } catch (err) {
    console.warn('Gagal mendaftarkan bot commands:', err.message);
  }

  console.log('Menjalankan bot DomainBot...');
  await bot.start({
    onStart: (botInfo) => {
      console.log(`🚀 DomainBot running as @${botInfo.username}`);
    },
  });
}

start().catch((err) => {
  console.error('Fatal error in bot.start:', err);
  process.exit(1);
});
