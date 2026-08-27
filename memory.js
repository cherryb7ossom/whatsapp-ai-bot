// memory.js
// Управление памятью диалога с клиентом.
//
// ПОЧЕМУ ЭТОТ ФАЙЛ ПОЯВИЛСЯ:
// раньше вся история чата хранилась в одном Map() внутри ai.js — только в
// оперативной памяти процесса. Это ломает контекст в двух типичных для
// мессенджер-ботов ситуациях:
//   1) Процесс перезапускается (деплой, падение, "усыпление" бесплатного
//      инстанса на Render при простое) — Map() исчезает целиком, бот не
//      помнит вообще ничего ни об одном клиенте.
//   2) Даже без перезапуска: "сырую" историю приходится жёстко обрезать
//      (иначе она будет бесконечно расти и раздувать промпт), и если имя
//      клиента было сказано в начале длинного диалога, оно просто
//      "вываливается" из окна — модель его больше не видит и переспрашивает.
//
// РЕШЕНИЕ (стандартный для ИИ-агентов в мессенджерах подход):
// разделить память на два слоя.
//   - "Короткая" память — последние N сырых сообщений, только в ОЗУ, нужна
//     для естественного потока диалога.
//   - "Длинная" память — компактный профиль клиента (имя + постоянно
//     обновляемое резюме диалога), который модель сама формулирует после
//     каждого сообщения. Профиль переживает обрезку сырой истории, а также
//     синхронно кэшируется в памяти и асинхронно сохраняется в CRM
//     (Google Sheets), поэтому переживает и перезапуск процесса — при
//     следующем сообщении клиента профиль подтягивается обратно.
//
// Плюс два стандартных для WhatsApp/Telegram-ботов момента:
//   - Очередь по chatId: два сообщения одного клиента, пришедшие почти
//     одновременно, не должны обрабатываться параллельно (иначе история
//     диалога перепутается).
//   - Небольшой дебаунс: если клиент шлёт несколько сообщений подряд
//     (частая история — "Привет" и следом отдельным сообщением "меня зовут
//     Иван"), лучше собрать их и ответить один раз осмысленно, чем
//     реагировать на каждый обрывок фразы по отдельности.

const crm = require('./crm');

const MAX_RAW_HISTORY = Number(process.env.MAX_HISTORY_MESSAGES || 20);
const DEBOUNCE_MS = Number(process.env.MESSAGE_DEBOUNCE_MS || 3500);
const IDLE_EVICT_MS = Number(process.env.MEMORY_IDLE_EVICT_MS || 6 * 60 * 60 * 1000); // 6 часов

// chatId -> { history, profile: {name, summary}, hydrated, queue, lastActivity }
const cache = new Map();

// chatId -> { parts: [], timer }
const pendingBuffers = new Map();

function emptyState() {
  return {
    history: [],
    profile: { name: null, summary: null },
    hydrated: false,
    queue: Promise.resolve(),
    lastActivity: Date.now(),
  };
}

function getCached(chatId) {
  if (!cache.has(chatId)) cache.set(chatId, emptyState());
  const state = cache.get(chatId);
  state.lastActivity = Date.now();
  return state;
}

// Подтягивает профиль клиента (имя + резюме) из CRM, если в памяти процесса
// его ещё нет — актуально сразу после перезапуска сервера. Вызывается один
// раз на чат за время жизни процесса (флаг hydrated), дальше профиль живёт
// только в ОЗУ и обновляется через mergeProfile.
async function hydrate(chatId) {
  const state = getCached(chatId);
  if (state.hydrated) return state;
  state.hydrated = true; // ставим сразу, чтобы параллельные вызовы не гидратировали дважды

  try {
    const saved = await crm.getState(chatId);
    if (saved) {
      state.profile.name = saved.name || null;
      state.profile.summary = saved.summary || null;
    }
  } catch (err) {
    console.error(`Не удалось восстановить профиль клиента ${chatId} из CRM:`, err.message);
  }
  return state;
}

function pushRaw(chatId, role, text) {
  const state = getCached(chatId);
  state.history.push({ role, parts: [{ text }] });
  if (state.history.length > MAX_RAW_HISTORY) {
    state.history.splice(0, state.history.length - MAX_RAW_HISTORY);
  }
}

// Объединяет новые извлечённые факты с уже известными. Ключевое правило:
// null/пусто от модели НЕ затирает то, что уже было известно — модель может
// не повторить имя в структурированном ответе каждый раз, это нормально.
function mergeProfile(chatId, extracted) {
  const state = getCached(chatId);
  if (extracted?.clientName) state.profile.name = extracted.clientName;
  if (extracted?.stageSummary) state.profile.summary = extracted.stageSummary;
  return state.profile;
}

// Последовательная очередь на chatId — гарантирует, что для одного клиента
// не выполняются два обращения к ИИ параллельно.
function runExclusive(chatId, fn) {
  const state = getCached(chatId);
  const run = state.queue.then(fn, fn);
  state.queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

// Собирает несколько быстро идущих подряд сообщений одного клиента в одно и
// вызывает onFlush(combinedText) один раз после паузы в переписке.
function bufferMessage(chatId, text, onFlush) {
  let buf = pendingBuffers.get(chatId);
  if (!buf) {
    buf = { parts: [], timer: null };
    pendingBuffers.set(chatId, buf);
  }
  buf.parts.push(text);

  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    pendingBuffers.delete(chatId);
    const combinedText = buf.parts.join('\n');
    runExclusive(chatId, () => onFlush(combinedText)).catch((err) => {
      console.error(`Ошибка обработки сообщений от ${chatId}:`, err);
    });
  }, DEBOUNCE_MS);
}

// Периодически чистим давно неактивные чаты из ОЗУ, чтобы Map не рос
// бесконечно при долгой работе процесса. Это безопасно: долговременный
// профиль (имя + резюме) уже сохранён в CRM и будет подтянут заново через
// hydrate(), если клиент напишет снова.
setInterval(() => {
  const now = Date.now();
  for (const [chatId, state] of cache.entries()) {
    if (now - state.lastActivity > IDLE_EVICT_MS) cache.delete(chatId);
  }
}, 30 * 60 * 1000).unref();

module.exports = { hydrate, pushRaw, mergeProfile, getCached, bufferMessage, runExclusive };
