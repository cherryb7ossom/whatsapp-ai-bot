// ai.js
// Обёртка над Google Gemini API. Модель возвращает структурированный JSON:
// текст ответа клиенту + оценку статуса диалога + имя клиента + обновлённое
// резюме диалога (см. memory.js — это то, что переживает обрезку истории и
// перезапуск процесса, и подставляется обратно в системный промпт).
// При временных сбоях (перегрузка 503, лимиты 429) делает несколько повторных
// попыток, прежде чем показать клиенту заготовленный текст — это редкость,
// а не норма.

const { buildSystemPrompt } = require('./prompt');
const memory = require('./memory');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Основная модель + резервная на случай, если основная перегружена
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-lite';

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING', description: 'Текст ответа клиенту, на его языке' },
    clientName: {
      type: 'STRING',
      nullable: true,
      description: 'Имя клиента, если он его называл в диалоге (сейчас или ранее), иначе null',
    },
    stageSummary: {
      type: 'STRING',
      nullable: true,
      description:
        'Обновлённое компактное резюме диалога (1-3 предложения): бизнес клиента, задача, ' +
        'что обсудили, возражения, этап. Учитывает предыдущее резюме, если оно было показано.',
    },
    status: {
      type: 'STRING',
      enum: ['новый', 'в_диалоге', 'заинтересован', 'отказался', 'готов_к_менеджеру'],
      description: 'Текущий статус вовлечённости клиента',
    },
  },
  required: ['reply', 'status'],
};

const FALLBACK = {
  reply: 'Извините, сейчас технические работы. Попробуйте написать чуть позже.',
  status: 'в_диалоге',
  clientName: null,
  stageSummary: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Один запрос к конкретной модели. Возвращает распарсенный результат
// либо бросает ошибку (в т.ч. помечает transient-ли она — стоит ли повторять).
async function callGemini(model, systemPrompt, history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: history,
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 500,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    const err = new Error(data?.error?.message || `Ошибка Gemini API (${model})`);
    err.status = data?.error?.code || response.status;
    err.transient = err.status === 503 || err.status === 429;
    throw err;
  }

  const rawText = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  return JSON.parse(rawText); // может бросить SyntaxError, если модель вернула не-JSON
}

// Пробует модель несколько раз с паузой, затем переключается на резервную модель.
async function askAI(chatId, userText) {
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY не задан в переменных окружения');
    return FALLBACK;
  }

  // Подтягивает профиль клиента (имя + резюме) из CRM, если процесс только
  // что перезапустился и в ОЗУ его ещё нет — иначе просто отдаёт то, что уже
  // закэшировано (см. memory.js). Только после этого добавляем новое сообщение
  // в сырую историю, чтобы hydrate успел подтянуть состояние ДО перезаписи.
  const state = await memory.hydrate(chatId);
  memory.pushRaw(chatId, 'user', userText);
  const history = state.history;
  const systemPrompt = buildSystemPrompt(state.profile);

  const attempts = [
    { model: PRIMARY_MODEL, delayBefore: 0 },
    { model: PRIMARY_MODEL, delayBefore: 1500 },
    { model: FALLBACK_MODEL, delayBefore: 0 },
    { model: FALLBACK_MODEL, delayBefore: 2000 },
  ];

  let lastError = null;

  for (const attempt of attempts) {
    if (attempt.delayBefore) await sleep(attempt.delayBefore);
    try {
      const parsed = await callGemini(attempt.model, systemPrompt, history);
      const reply = parsed.reply || FALLBACK.reply;
      memory.pushRaw(chatId, 'model', reply);

      // Профиль обновляется аддитивно: null/пусто от модели не затирает то,
      // что уже было известно (см. mergeProfile в memory.js).
      const profile = memory.mergeProfile(chatId, {
        clientName: parsed.clientName || null,
        stageSummary: parsed.stageSummary || null,
      });

      return {
        reply,
        status: parsed.status || 'в_диалоге',
        clientName: profile.name,
        stageSummary: profile.summary,
      };
    } catch (err) {
      lastError = err;
      console.error(`Попытка через ${attempt.model} не удалась:`, err.message);
      // если ошибка не временная (например, неверный ключ) — нет смысла долбить дальше эту же модель,
      // но резервную модель всё равно стоит попробовать один раз
      if (err.transient === false && attempt.model === FALLBACK_MODEL) break;
    }
  }

  console.error('Все попытки обращения к Gemini исчерпаны:', lastError?.message);
  return FALLBACK;
}

module.exports = { askAI };
