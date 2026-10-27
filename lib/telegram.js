/**
 * Telegram Bot API helpers for CHM2 (v2).
 * Uses Node https — works from networks that can reach api.telegram.org
 * (Playwright fallback if HTTPS is blocked).
 */
const https = require('https');

let TOKEN = '';
let CHAT_IDS = [];
let CONFIRM_TOKEN = '';
let CONFIRM_CHAT_IDS = [];
let offset = 0;
let polling = false;

function parseIds(chatIds) {
  return (Array.isArray(chatIds) ? chatIds : String(chatIds || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
}

function configure({ token, chatIds, confirmToken, confirmChatIds }) {
  TOKEN = token;
  CHAT_IDS = parseIds(chatIds);
  // Confirmations: separate bot and/or chat. Falls back to alert bot/chats.
  CONFIRM_TOKEN = confirmToken || token;
  CONFIRM_CHAT_IDS = parseIds(confirmChatIds).length
    ? parseIds(confirmChatIds)
    : CHAT_IDS;
}

function apiWithToken(token, method, body = {}) {
  return new Promise((resolve) => {
    if (!token) {
      resolve({ ok: false, description: 'No Telegram token' });
      return;
    }
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve({ ok: false, description: raw.substring(0, 200) });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, description: e.message }));
    req.setTimeout(70_000, () => {
      req.destroy();
      resolve({ ok: false, description: 'Telegram timeout' });
    });
    req.write(data);
    req.end();
  });
}

function api(method, body = {}) {
  return apiWithToken(TOKEN, method, body);
}

async function sendToChat(chatId, text, extra = {}) {
  return api('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    ...extra,
  });
}

async function sendAll(text, extra = {}) {
  const results = [];
  for (const id of CHAT_IDS) {
    results.push(await sendToChat(id, text, extra));
  }
  return results;
}

/** Booking confirmations / manage links — alert chat stays clean */
async function sendConfirm(text, extra = {}) {
  const results = [];
  for (const id of CONFIRM_CHAT_IDS) {
    results.push(
      await apiWithToken(CONFIRM_TOKEN, 'sendMessage', {
        chat_id: id,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        ...extra,
      })
    );
  }
  return results;
}

function confirmDestination() {
  const sameToken = CONFIRM_TOKEN === TOKEN;
  const sameChats =
    CONFIRM_CHAT_IDS.length === CHAT_IDS.length &&
    CONFIRM_CHAT_IDS.every((id, i) => id === CHAT_IDS[i]);
  return {
    chatIds: CONFIRM_CHAT_IDS,
    separate: !(sameToken && sameChats),
  };
}

async function sendAlertWithBookButton({ text, callbackData, buttonLabel = 'BOOK' }) {
  return sendAlertWithButtons({
    text,
    buttons: [[{ text: buttonLabel, callback_data: callbackData }]],
  });
}

/** @param {{ text: string, buttons: Array<Array<{text:string,callback_data:string}>> }} opts */
async function sendAlertWithButtons({ text, buttons }) {
  return sendAll(text, {
    reply_markup: { inline_keyboard: buttons },
    disable_web_page_preview: true,
  });
}

async function editMessageMarkup(chatId, messageId, replyMarkup) {
  return api('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

async function editMessageText(chatId, messageId, text, extra = {}) {
  return api('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

async function answerCallback(callbackQueryId, text = '') {
  return api('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || undefined,
    show_alert: false,
  });
}

/**
 * Drop any queued updates so old BOOK taps don't fire after a restart.
 */
async function flushPendingUpdates(onLog = () => {}) {
  let localOffset = offset || 0;
  for (let i = 0; i < 10; i++) {
    const res = await api('getUpdates', {
      offset: localOffset,
      timeout: 0,
      allowed_updates: ['callback_query', 'message'],
    });
    if (!res.ok) {
      onLog(`Telegram flush error: ${res.description || JSON.stringify(res)}`);
      break;
    }
    const batch = res.result || [];
    if (!batch.length) break;
    localOffset = batch[batch.length - 1].update_id + 1;
    onLog(`Telegram flush: dropped ${batch.length} queued update(s)`);
  }
  offset = localOffset;
}

/**
 * Long-poll getUpdates. Calls onCallback({ id, data, chatId, messageId, from })
 */
async function startPolling(onCallback, onLog = () => {}) {
  if (polling) return;
  polling = true;
  onLog('Telegram long-poll started');

  while (polling) {
    const res = await api('getUpdates', {
      offset,
      timeout: 50,
      allowed_updates: ['callback_query', 'message'],
    });

    if (!res.ok) {
      onLog(`Telegram poll error: ${res.description || JSON.stringify(res)}`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const upd of res.result || []) {
      offset = upd.update_id + 1;
      if (upd.callback_query) {
        const cq = upd.callback_query;
        try {
          await onCallback({
            id: cq.id,
            data: cq.data || '',
            chatId: cq.message?.chat?.id,
            messageId: cq.message?.message_id,
            messageText: cq.message?.text || '',
            from: cq.from,
          });
        } catch (err) {
          onLog(`Callback handler error: ${err.message}`);
          await answerCallback(cq.id, 'Error');
        }
      }
    }
  }
}

function stopPolling() {
  polling = false;
}

module.exports = {
  configure,
  sendAll,
  sendConfirm,
  confirmDestination,
  sendToChat,
  sendAlertWithBookButton,
  sendAlertWithButtons,
  editMessageMarkup,
  editMessageText,
  answerCallback,
  flushPendingUpdates,
  startPolling,
  stopPolling,
  api,
};
