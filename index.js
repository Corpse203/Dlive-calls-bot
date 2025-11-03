import 'dotenv/config';
import axios from 'axios';
import WebSocket from 'ws';

/**
 * DLive chat bot sans AUTH
 * - Connexion directe au WebSocket "graphigostream.prd.dlive.tv"
 * - Surveille les messages du chat du streamer défini dans DLIVE_CHANNEL
 * - Détecte les commandes !call "slot" et les envoie à ton site
 * - Reconnexion automatique si le WS se ferme
 *
 * ✅ Simple, aucun token requis
 */

// ---- Config ----
const CHANNEL_DISPLAY = process.env.DLIVE_CHANNEL; // ex: Skrymi
const BASE_URL = (process.env.CALLS_BASE_URL || '').replace(/\/$/, '');
const ENDPOINT = process.env.CALLS_ENDPOINT || '/api/calls';
const SHARED = process.env.CALLS_SHARED_SECRET || '';

if (!CHANNEL_DISPLAY || !BASE_URL) {
  console.error('[config] DLIVE_CHANNEL et CALLS_BASE_URL sont requis');
  process.exit(1);
}

// ---- Helpers ----
// accepte !call "slot", !call 'slot' ou !call slot
const CALL_CMD = /^!call\s+(?:(["'])(?<slotQuoted>[^"']{1,80})\1|(?<slotBare>\S.+))$/i;

function parseCallCommand(text) {
  const m = text.match(CALL_CMD);
  if (!m) return null;
  return (m.groups.slotQuoted || m.groups.slotBare || "").trim();
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

// ---- Connexion au chat via WebSocket ----
function subscribeChat(streamer, onMessage) {
  const ws = new WebSocket("wss://graphigostream.prd.dlive.tv/", "graphql-ws");

  ws.on("open", () => {
    console.log(`[dlive] WS ouvert pour ${streamer}`);
    ws.send(JSON.stringify({ type: "connection_init", payload: {} }));

    // abonnement aux messages du chat
    ws.send(JSON.stringify({
      id: "2",
      type: "start",
      payload: {
        variables: { streamer, viewer: "" },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "1246db4612a2a1acc520afcbd34684cdbcebad35bcfff29dcd7916a247722a7a"
          }
        },
        operationName: "StreamMessageSubscription",
        query: `subscription StreamMessageSubscription($streamer: String!, $viewer: String) {
          streamMessageReceived(streamer: $streamer, viewer: $viewer) {
            type
            ... on ChatText {
              id
              emojis
              content
              createdAt
              sender { username displayname }
              __typename
            }
          }
        }`
      }
    }));
  });

  ws.on("message", (buf) => {
    try {
      const data = JSON.parse(buf.toString());
      if (data.type === "connection_ack" || data.type === "ka") return;
      const msg = data?.payload?.data?.streamMessageReceived?.[0];
      if (!msg) return;
      onMessage(msg);
    } catch (e) {
      console.error("[ws] parse error:", e);
    }
  });

  ws.on("error", (e) => {
    console.error("[ws] erreur:", e?.message || e);
  });

  ws.on("close", (code) => {
    console.log(`[ws] fermé (${code}). Reconnexion dans 5s...`);
    setTimeout(() => subscribeChat(streamer, onMessage), 5000);
  });

  return ws;
}

// ---- Lancement ----
(async () => {
  try {
    // On saute la résolution GraphQL et on prend directement le nom du channel
    const streamer = CHANNEL_DISPLAY.toLowerCase();
    console.log(`[dlive] streamer forcé: ${streamer}`);

    subscribeChat(streamer, async (msg) => {
      if (msg?.type === "Message" && msg.__typename === "ChatText") {
        const text = (msg?.content || "").trim();
        const displayName = msg?.sender?.displayname || msg?.sender?.username || "inconnu";
        const slot = parseCallCommand(text);
        if (!slot) return;

        const result = await sendCall(slot, displayName);
        if (result.ok) {
          const mode = result.fallback ? 'GET' : 'POST';
          console.log(`✅ Call ajouté pour « ${slot} » par ${displayName} (${mode}).`);
        } else {
          console.log(`❌ Ajout impossible (« ${slot} ») — ${result.error}`);
        }
      }
    });
  } catch (e) {
    console.error("[init] erreur:", e?.message || e);
    process.exit(1);
  }
})();
