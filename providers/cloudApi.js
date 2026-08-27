// providers/cloudApi.js
// Реализация общего интерфейса провайдера для официального Meta WhatsApp Cloud API.
// Пригодится, когда решите перейти с Green API на официальный API — просто
// смените WHATSAPP_PROVIDER=cloud в переменных окружения, код менять не надо.

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

async function sendMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('Ошибка отправки через Cloud API:', data);
  } else {
    console.log('Ответ отправлен клиенту (Cloud API):', to);
  }
  return data;
}

function parseIncoming(body) {
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];

  if (!message) return null;

  const from = message.from;
  const text = message.text?.body;

  if (!from || !text) return null;

  return { from, text };
}

function verifyWebhook(query) {
  // Meta шлёт GET-запрос с этими параметрами при подключении вебхука
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return challenge;
  }
  return null;
}

module.exports = { sendMessage, parseIncoming, verifyWebhook };
