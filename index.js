import 'dotenv/config';
import axios from 'axios';
import WebSocket from 'ws';

/**
 * DLive chat bot WITHOUT AUTH KEY.
 * - Resolves channel -> streamer username via public GraphQL POST
 * - Opens WS 'graphql-ws' to graphigostream.prd.dlive.tv
 * - Subscribes to StreamMessageSubscription
 * - On ChatText matching !call "slot", POSTs to your endpoint (with fallback GET)
 *
 * DISCLAIMER: Uses **unofficial** endpoints/protocol; may break if DLive changes.
 */

// ---- Config ----
const CHANNEL_DISPLAY = process.env.DLIVE_CHANNEL; // ex: FuturFormatic (as seen in URL)
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

// Resolve displayname -> username (streamer)
async function resolveStreamer(displayname) {
  const query = {
    operationName: "LivestreamPage",
    variables: {
      displayname,
      add: false,
      isLoggedIn: false,
      isMe: false,
      showUnpicked: false,
      order: "PickTime"
    },
    extensions: {
      persistedQuery: { version: 1, sha256Hash: "2e6216b014c465c64e5796482a3078c7ec7fbc2742d93b072c03f523dbcf71e2" }
    }
  };
  const res = await fetch("https://graphigo.prd.dlive.tv/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query)
  });
  if (!res.ok) throw new Error(`Graphigo HTTP ${res.status}`);
  const data = await res.json();
  const username = data?.data?.userByDisplayName?.username;
  if (!username) throw new Error(`Channel "${displayname}" introuvable`);
  return username;
}

// Subscribe to chat via WS
function subscribeChat(streamer, onMessage) {
  const ws = new WebSocket("wss://graphigostream.prd.dlive.tv/", "graphql-ws");

  ws.on("open", () => {
    console.log(`[dlive] WS ouvert pour ${streamer}`);
    ws.send(JSON.stringify({ type: "connection_init", payload: {} }));

    // start subscription (messages)
    ws.send(JSON.stringify({
      id: "2",
      type: "start",
      payload: {
        variables: { streamer, viewer: "" },
        extensions: { persistedQuery: { version: 1, sha256Hash: "1246db4612a2a1acc520afcbd34684cdbcebad35bcfff29dcd7916a247722a7a" } },
        operationName: "StreamMessageSubscription",
        query: "subscription StreamMessageSubscription($streamer: String!, $viewer: String) { streamMessageReceived(streamer: $streamer, viewer: $viewer) { type ... on ChatText { id emojis content createdAt subLength ...VStreamChatSenderInfoFrag __typename } ... on ChatGift { id gift amount message recentCount expireDuration ...VStreamChatSenderInfoFrag __typename } ... on ChatFollow { id ...VStreamChatSenderInfoFrag __typename } ... on ChatHost { id viewer ...VStreamChatSenderInfoFrag __typename } ... on ChatSubscription { id month ...VStreamChatSenderInfoFrag __typename } ... on ChatExtendSub { id month length ...VStreamChatSenderInfoFrag __typename } ... on ChatChangeMode { mode __typename } ... on ChatSubStreak { id ...VStreamChatSenderInfoFrag length __typename } ... on ChatClip { id url ...VStreamChatSenderInfoFrag __typename } ... on ChatDelete { ids __typename } ... on ChatBan { id ...VStreamChatSenderInfoFrag bannedBy { id displayname __typename } bannedByRoomRole __typename } ... on ChatModerator { id ...VStreamChatSenderInfoFrag add __typename } ... on ChatEmoteAdd { id ...VStreamChatSenderInfoFrag emote __typename } ... on ChatTimeout { id ...VStreamChatSenderInfoFrag minute bannedBy { id displayname __typename } bannedByRoomRole __typename } ... on ChatTCValueAdd { id ...VStreamChatSenderInfoFrag amount totalAmount __typename } ... on ChatGiftSub { id ...VStreamChatSenderInfoFrag count receiver __typename } ... on ChatGiftSubReceive { id ...VStreamChatSenderInfoFrag gifter __typename } __typename } } fragment VStreamChatSenderInfoFrag on SenderInfo { subscribing role roomRole sender { id username displayname avatar partnerStatus badges effect __typename } __typename }"
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

(async () => {
  try {
    const streamer = await resolveStreamer(CHANNEL_DISPLAY);
    console.log(`[dlive] Channel ${CHANNEL_DISPLAY} -> streamer username: ${streamer}`);

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
