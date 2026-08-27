// providers/greenApi.js
// Реализация общего интерфейса провайдера для Green API.
// Общий интерфейс (одинаковый у всех провайдеров):
//   sendMessage(to, text)        -> отправить сообщение
//   parseIncoming(body)          -> { from, text } | null (разобрать вебхук)
//   verifyWebhook(req)           -> ответ на проверочный GET-запрос (не нужен Green API)

const ID_INSTANCE = process.env.GREEN_API_ID_INSTANCE;
const API_TOKEN_INSTANCE = process.env.GREEN_API_TOKEN_INSTANCE;

const BASE_URL = `https://api.green-api.com/waInstance${ID_INSTANCE}`;

async function sendMessage(to, text) {
  // Green API ожидает chatId в формате "79001234567@c.us"
  const chatId = to.includes('@') ? to : `${to}@c.us`;

  const url = `${BASE_URL}/sendMessage/${API_TOKEN_INSTANCE}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, message: text }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('Ошибка отправки через Green API:', data);
  } else {
    console.log('Ответ отправлен клиенту (Green API):', chatId);
  }
  return data;
}

function parseIncoming(body) {
  // Green API присылает разные типы вебхуков, нам нужны только входящие сообщения
  if (body.typeWebhook !== 'incomingMessageReceived') return null;

  const chatId = body.senderData?.chatId; // например 79001234567@c.us
  const messageData = body.messageData;

  let text = null;
  if (messageData?.typeMessage === 'textMessage') {
    text = messageData.textMessageData?.textMessage;
  } else if (messageData?.typeMessage === 'extendedTextMessage') {
    text = messageData.extendedTextMessageData?.text;
  }

  if (!chatId || !text) return null;

  return { from: chatId, text };
}

function verifyWebhook() {
  // У Green API нет отдельного шага верификации вебхука через GET, как у Meta
  return null;
}

module.exports = { sendMessage, parseIncoming, verifyWebhook };
