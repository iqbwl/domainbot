import { config } from '../config.js';

// Helper: Check if user is an authorized admin
export function isAdmin(ctx) {
  const userId = ctx.from?.id;
  return config.adminIds.size === 0 || config.adminIds.has(userId);
}

// Helper: Escape special characters for Telegram legacy Markdown
export function escapeMd(text) {
  if (!text) return '';
  return String(text).replace(/[*_`\[]/g, '\\$&');
}

// Helper: Send Native Rich Message (Bot API 10.1) with fallback
export async function sendRichOrPlain(bot, chatId, markdown, options = {}) {
  const payload = {
    chat_id: chatId,
    rich_message: { markdown }
  };
  if (options.message_thread_id && !isNaN(options.message_thread_id)) {
    payload.message_thread_id = Number(options.message_thread_id);
  }

  try {
    return await bot.api.raw.sendRichMessage(payload);
  } catch (err) {
    console.warn(`sendRichMessage failed for ${chatId}, falling back to sendMessage: ${err.message}`);
    const sendOpts = { parse_mode: 'Markdown' };
    if (options.message_thread_id && !isNaN(options.message_thread_id)) {
      sendOpts.message_thread_id = Number(options.message_thread_id);
    }
    return await bot.api.sendMessage(chatId, markdown, sendOpts);
  }
}

// Help Message
export function getHelpMessage(isPrivate = false) {
  let msg = `🌐 *Domain Monitoring Bot*

*Commands:*
• \`/domain list\` — Download complete \`.md\` report file with status table
• \`/domain add <domain> <owner>\` — Add domain to monitoring (auto WHOIS)
• \`/domain edit <domain> <new_owner>\` — Update domain owner name instantly
• \`/domain delete <domain>\` — Remove domain from monitoring list
• \`/domain check <domain>\` — Realtime WHOIS check without saving to database
• \`/domain expiring [days]\` — Summary of domains nearing expiration (default: 30 days)
• \`/domain sync\` — Re-sync all domain WHOIS data in the background`;

  if (isPrivate) {
    msg += `
• \`/domain testalert\` — Test dispatching expiration alert notification
• 📎 *Upload CSV:* Send a \`.csv\` file directly to import domains in bulk`;
  }

  msg += `

*Usage Examples:*
• \`/domain add example.co.id Acme Corporation\`
• \`/domain edit example.co.id Tech Global Inc\``;

  return msg;
}
