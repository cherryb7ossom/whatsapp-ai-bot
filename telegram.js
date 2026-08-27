// telegram.js
// Отправка уведомлений администратору в Telegram: о новых клиентах и по запросу отчёта.

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

const API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN не задан — уведомление не отправлено');
    return;
  }
  try {
    await fetch(`${API_URL}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error('Ошибка отправки сообщения в Telegram:', err);
  }
}

async function notifyAdminNewClient(name, chatId) {
  if (!ADMIN_CHAT_ID) return;
  const text = `🆕 Новый клиент!\nИмя: ${name || 'не указано'}\nWhatsApp: ${chatId}`;
  await sendTelegramMessage(ADMIN_CHAT_ID, text);
}

module.exports = { sendTelegramMessage, notifyAdminNewClient };
