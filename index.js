import 'dotenv/config';
import axios from 'axios';
import Dlive from 'dlivetv-api';

// ---- Config ----
const AUTH_KEY = process.env.DLIVE_AUTH_KEY;
const CHANNEL = process.env.DLIVE_CHANNEL; // ex: MonChannel
const BASE_URL = (process.env.CALLS_BASE_URL || '').replace(/\/$/, '');
const ENDPOINT = process.env.CALLS_ENDPOINT || '/api/calls';
const SHARED = process.env.CALLS_SHARED_SECRET || '';

if (!AUTH_KEY || !CHANNEL || !BASE_URL) {
  console.error('[config] DLIVE_AUTH_KEY, DLIVE_CHANNEL et CALLS_BASE_URL sont requis');
  process.exit(1);
}

// ---- Utilitaires ----
// !call "ma slot"  ou  !call 'ma slot'
const CALL_CMD = /^!call\s+([\"'])(?<slot>[^\1]{1,80})\1\s*$/i;

function parseCallCommand(text) {
  const m = text.match(CALL_CMD);
  return m?.groups?.slot?.trim();
}

async function sendCall(slot, user) {
  const payload = { slot, user };
  if (SHARED) payload.auth = SHARED;

  const url = `${BASE_URL}${ENDPOINT}`;
  try {
    const res = await axios.post(url, payload, { timeout: 10_000 });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    try {
      const params = new URLSearchParams({ slot, user, ...(SHARED ? { auth: SHARED } : {}) });
      const res2 = await axios.get(`${url}?${params.toString()}`, { timeout: 10_000 });
      return { ok: true, status: res2.status, data: res2.data, fallback: true };
    } catch (err2) {
      return { ok: false, error: err2?.response?.data || err2?.message || String(err2) };
    }
  }
}

// ---- Bot DLive ----
const bot = new Dlive(AUTH_KEY, CHANNEL);

bot.on('ready', () => {
  console.log(`[dlive] Connecté sur #${CHANNEL}`);
});

bot.on('ChatText', async (msg) => {
  try {
    const text = (msg?.content || '').trim();
    const displayName = msg?.sender?.displayname || msg?.sender?.username || 'inconnu';

    const slot = parseCallCommand(text);
    if (!slot) return; // on ignore les autres messages

    const result = await sendCall(slot, displayName);

    if (result.ok) {
      const mode = result.fallback ? 'GET' : 'POST';
      bot.sendMessage(`✅ Call ajouté pour « ${slot} » par ${displayName} (${mode}).`);
    } else {
      bot.sendMessage(`❌ Impossible d'ajouter le call (« ${slot} »).`);
      console.error('[calls] erreur:', result.error);
    }
  } catch (e) {
    console.error('[ChatText] erreur:', e);
  }
});

bot.on('close', () => {
  console.log('[dlive] connexion fermée');
});

bot.on('error', (err) => {
  console.error('[dlive] erreur:', err);
});
