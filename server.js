// server.js
// Точка входа. Выбирает провайдера WhatsApp, принимает входящие сообщения,
// вызывает ИИ, сохраняет клиента в CRM (Google Sheets) и уведомляет в Telegram.
// Также принимает вебхук от Telegram для команды /report.

const express = require('express');
const { askAI } = require('./ai');
const crm = require('./crm');
const memory = require('./memory');
const { sendTelegramMessage, notifyAdminNewClient } = require('./telegram');

const app = express();
app.use(express.json());

const PROVIDER_NAME = process.env.WHATSAPP_PROVIDER || 'green';
const provider =
  PROVIDER_NAME === 'cloud'
    ? require('./providers/cloudApi')
    : require('./providers/greenApi');

const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

console.log(`Активный провайдер WhatsApp: ${PROVIDER_NAME}`);

// ==== ПРОВЕРКА WEBHOOK WHATSAPP (нужна только для Cloud API) ====
app.get('/webhook', (req, res) => {
  const challenge = provider.verifyWebhook?.(req.query);
  if (challenge) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ==== ПРИЁМ ВХОДЯЩИХ СООБЩЕНИЙ WHATSAPP ====
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const incoming = provider.parseIncoming(req.body);
    if (!incoming) return;

    const { from, text } = incoming;
    console.log(`Входящее от ${from}: ${text}`);

    // Сообщения одного клиента, пришедшие почти одновременно (частая
    // ситуация в WhatsApp — "Привет" и через секунду "меня зовут Иван"),
    // собираются в одно и обрабатываются один раз после паузы. Это же
    // гарантирует, что для одного chatId не выполняются два обращения к ИИ
    // параллельно (см. memory.bufferMessage/runExclusive).
    memory.bufferMessage(from, text, async (combinedText) => {
      const { reply, status, clientName, stageSummary } = await askAI(from, combinedText);
      await provider.sendMessage(from, reply);

      const { isNew } = await crm.upsertClient({
        chatId: from,
        name: clientName,
        status,
        lastMessage: combinedText,
        summary: stageSummary,
      });

      if (isNew) {
        await notifyAdminNewClient(clientName, from);
      }
    });
  } catch (err) {
    console.error('Ошибка обработки входящего сообщения:', err);
  }
});

// ==== TELEGRAM: команда /report от администратора ====
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.message;
    if (!msg || !msg.text) return;

    const chatId = String(msg.chat.id);
    const text = msg.text.trim().toLowerCase();

    if (!TELEGRAM_ADMIN_CHAT_ID || chatId !== TELEGRAM_ADMIN_CHAT_ID) {
      return; // отвечаем только заранее заданному администратору
    }

    if (text === '/report' || text === '/отчет' || text === '/отчёт') {
      const rows = await crm.getAllClients();
      await sendTelegramMessage(chatId, crm.formatReport(rows));
    }
  } catch (err) {
    console.error('Ошибка обработки Telegram webhook:', err);
  }
});

app.get('/', (req, res) => {
  res.send('WhatsApp AI sales bot is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
