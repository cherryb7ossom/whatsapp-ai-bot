// crm.js
// Хранит клиентов в Google Sheets — бесплатно, не нужно поднимать отдельную БД.
// Таблица должна называться "Клиенты" (лист/вкладка), колонки:
// A: chatId | B: Имя | C: Статус | D: Последнее сообщение | E: Первое обращение
// F: Обновлено | G: Резюме диалога (долгая память — см. memory.js)
//
// Колонка G — это то, что позволяет боту не терять контекст (имя клиента,
// суть разговора) после перезапуска процесса (деплой, "усыпление" бесплатного
// инстанса на Render): при следующем сообщении клиента memory.hydrate()
// подтягивает имя и резюме отсюда через getState().

const { JWT } = require('google-auth-library');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const SHEET_NAME = 'Клиенты';
const RANGE = `${SHEET_NAME}!A2:G`;

function isConfigured() {
  return Boolean(SHEET_ID && SERVICE_ACCOUNT_EMAIL && PRIVATE_KEY);
}

let cachedClient = null;

async function getAccessToken() {
  if (!cachedClient) {
    cachedClient = new JWT({
      email: SERVICE_ACCOUNT_EMAIL,
      key: PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  const token = await cachedClient.authorize();
  return token.access_token;
}

async function sheetsFetch(path, options = {}) {
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    console.error('Google Sheets вернул не-JSON ответ. Диагностика:');
    console.error('  URL запроса (без ключа):', url);
    console.error('  HTTP статус:', response.status);
    console.error('  Content-Type ответа:', response.headers.get('content-type'));
    console.error('  Начало ответа:', rawText.slice(0, 200));
    throw new Error('Google Sheets API вернул некорректный ответ');
  }

  if (!response.ok) {
    console.error('Ошибка Google Sheets API:', JSON.stringify(data));
  }
  return data;
}

async function getRows() {
  const data = await sheetsFetch(`/values/${encodeURIComponent(RANGE)}`);
  return data.values || [];
}

// Добавляет нового клиента или обновляет существующего (по chatId).
// summary — необязательное компактное резюме диалога из долгой памяти (memory.js).
// Возвращает { isNew: true/false }.
async function upsertClient({ chatId, name, status, lastMessage, summary }) {
  if (!isConfigured()) {
    console.warn('Google Sheets не настроен (нет переменных окружения) — сохранение клиента пропущено');
    return { isNew: false };
  }

  try {
    const rows = await getRows();
    const index = rows.findIndex((row) => row[0] === chatId);
    const now = new Date().toLocaleString('ru-RU');

    if (index === -1) {
      await sheetsFetch(
        `/values/${encodeURIComponent(RANGE)}:append?valueInputOption=USER_ENTERED`,
        {
          method: 'POST',
          body: JSON.stringify({
            values: [[chatId, name || '', status, lastMessage, now, now, summary || '']],
          }),
        }
      );
      return { isNew: true };
    }

    const rowNumber = index + 2; // данные начинаются со строки 2 (строка 1 — заголовки)
    const target = `${SHEET_NAME}!A${rowNumber}:G${rowNumber}`;
    await sheetsFetch(`/values/${encodeURIComponent(target)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      body: JSON.stringify({
        values: [
          [
            chatId,
            name || rows[index][1] || '',
            status,
            lastMessage,
            rows[index][4] || now,
            now,
            summary || rows[index][6] || '',
          ],
        ],
      }),
    });
    return { isNew: false };
  } catch (err) {
    console.error('Ошибка сохранения клиента в CRM:', err);
    return { isNew: false };
  }
}

// Восстанавливает долговременный профиль клиента (имя + резюме диалога) из
// таблицы. Используется memory.hydrate() один раз на чат за время жизни
// процесса — актуально сразу после рестарта/деплоя/пробуждения инстанса,
// когда оперативная память бота пуста.
async function getState(chatId) {
  if (!isConfigured()) return null;
  try {
    const rows = await getRows();
    const row = rows.find((r) => r[0] === chatId);
    if (!row) return null;
    return { name: row[1] || null, summary: row[6] || null };
  } catch (err) {
    console.error(`Ошибка чтения состояния клиента ${chatId} из CRM:`, err.message);
    return null;
  }
}

async function getAllClients() {
  if (!isConfigured()) return [];
  try {
    return await getRows();
  } catch (err) {
    console.error('Ошибка чтения клиентов из CRM:', err);
    return [];
  }
}

function formatReport(rows) {
  if (!rows.length) return 'Клиентов пока нет.';

  const counts = {};
  rows.forEach((row) => {
    const status = row[2] || 'неизвестно';
    counts[status] = (counts[status] || 0) + 1;
  });

  const summaryLines = Object.entries(counts).map(([status, count]) => `• ${status}: ${count}`);

  const listLines = rows
    .slice(-15)
    .map((row) => `${row[1] || 'без имени'} (${row[0]}) — ${row[2]}`)
    .reverse();

  return [
    '📊 Отчёт по клиентам',
    `Всего: ${rows.length}`,
    '',
    'По статусам:',
    ...summaryLines,
    '',
    'Последние 15 клиентов:',
    ...listLines,
  ].join('\n');
}

module.exports = { upsertClient, getAllClients, formatReport, getState };