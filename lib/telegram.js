/**
 * Telegram Bot API helpers for CHM2 (v2).
 * Uses Node https — works from networks that can reach api.telegram.org
 * (Playwright fallback if HTTPS is blocked).
 */
const https = require('https');

let TOKEN = '';
let CHAT_IDS = [];
let offset = 0;
let polling = false;

function configure({ token, chatIds }) {
  TOKEN = token;
  CHAT_IDS = (Array.isArray(chatIds) ? chatIds : String(chatIds || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
}

function api(method, body = {}) {
  return new Promise((resolve) => {
    if (!TOKEN) {
      resolve({ ok: false, description: 'No TELEGRAM_BOT_TOKEN' });
      return;
    }
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${TOKEN}/${method}`,
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

async function sendAlertWithBookButton({ text, callbackData, buttonLabel = 'BOOK' }) {
  const keyboard = {
    inline_keyboard: [[{ text: buttonLabel, callback_data: callbackData }]],
  };
  return sendAll(text, { reply_markup: keyboard });
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
  sendToChat,
  sendAlertWithBookButton,
  editMessageMarkup,
  editMessageText,
  answerCallback,
  startPolling,
  stopPolling,
  api,
};
