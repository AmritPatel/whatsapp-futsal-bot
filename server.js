// server.js
// WhatsApp Futsal Bot — simple 3x5 team balancer
// Env required: VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID
// Optional: GRAPH_API_VERSION (defaults to v21.0), PORT

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- Config ----------
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const PHONE_NUMBER_ID   = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN    = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;

if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN || !VERIFY_TOKEN) {
  console.warn('[WARN] Missing one or more env vars: PHONE_NUMBER_ID, WHATSAPP_TOKEN, VERIFY_TOKEN');
}

const WA_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
const AUTH   = { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } };

// ---------- Tiny memory for "Shuffle again" ----------
const lastPlayersByUser = new Map(); // key: sender E.164 digits, val: array of 15 names

// ---------- Helpers: team formatting ----------
const COLORS = [
  { name: 'YELLOW', emoji: '🟡' }, // Team A
  { name: 'BLUE',   emoji: '🔵' }, // Team B
  { name: 'RED',    emoji: '🔴' }, // Team C
];

function formatTeamsBlocks(teams) {
  // teams = [ [5 names], [5 names], [5 names] ]
  const blocks = teams.map((t, i) => {
    const header = `${COLORS[i].emoji}  ${COLORS[i].name}`;
    const body   = t.map(n => `• ${n}`).join('\n');
    return `${header}\n${body}`;
  });
  return `Teams for tonight:\n\n${blocks.join('\n\n')}\n\nHave fun! ⚽`;
}

// ---------- Helpers: sending ----------
async function sendText(to, body) {
  // "to" must be digits-only E.164 (no + / spaces). Incoming msg.from is already digits-only.
  return axios.post(WA_URL, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body }
  }, AUTH);
}

async function sendButtons(to) {
  return axios.post(WA_URL, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Want anything else?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'shuffle', title: 'Shuffle again' } },
          { type: 'reply', reply: { id: 'help',    title: 'Help' } }
        ]
      }
    }
  }, AUTH);
}

// ---------- Helpers: team making ----------
function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeTeams(players15) {
  // players15: array of 15 names
  const s = shuffle(players15);
  return [s.slice(0, 5), s.slice(5, 10), s.slice(10, 15)];
}

// ---------- Helpers: parsing ----------
function parsePlayers(raw) {
  if (!raw) return [];

  // Normalize weird spaces & punctuation
  let text = raw
    .replace(/\u200B|\u200C|\u200D|\u2060/g, '') // zero-widths
    .replace(/\r/g, '')
    .replace(/[•\-\u2022\u2023\u25E6\u2043\u2219]/g, '•') // normalize bullets
    .trim();

  // Case 1: "teams: a, b, c, ... "
  const m = text.match(/^teams?\s*:\s*(.+)$/i);
  if (m) {
    const names = m[1].split(',').map(cleanName).filter(Boolean);
    return names;
  }

  // Case 2: Pasted signup list with numbers/notes, e.g.:
  // 1.Rajesh (Bibs)
  // 2. Anish
  // 3) Juan
  // 4 - Kunal
  const lines = text.split('\n');
  const names = [];
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    // strip leading numbering like "1.", "10 -", "3) ", "11) - "
    line = line.replace(/^\s*\d{1,3}\s*[\.\)\-:]?\s*/,'');
    // remove trailing/inline notes like "(Bibs)"
    line = line.replace(/\((?:[^()]*)\)/g, '');
    // collapse multiple spaces
    line = line.replace(/\s{2,}/g, ' ');
    const n = cleanName(line);
    if (n) names.push(n);
  }
  return names;
}

function cleanName(s) {
  if (!s) return '';
  let t = s
    .replace(/^[\W_]+|[\W_]+$/g, '')   // trim non-letters at ends
    .replace(/\s{2,}/g, ' ')
    .trim();
  // guard against numeric-only like "97" – allow it (per your list)
  return t;
}

// ---------- Web: health ----------
app.get('/', (req, res) => {
  res.status(200).send('Futsal bot up');
});

// ---------- Webhook: verify ----------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[VERIFY] Success');
    return res.status(200).send(challenge);
  }
  console.warn('[VERIFY] Failed: mode/token mismatch');
  return res.sendStatus(403);
});

// ---------- Webhook: receive ----------
app.post('/webhook', async (req, res) => {
  // Always 200 quickly to acknowledge delivery
  res.sendStatus(200);

  try {
    const body = req.body || {};
    console.log('INBOUND WEBHOOK:', JSON.stringify(body, null, 2));

    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};

        // It's either a message or a status callback. We only handle messages here.
        const messages = v.messages || [];
        if (!messages.length) continue;

        for (const msg of messages) {
          const from = msg.from; // sender E.164 digits
          const type = msg.type;

          // --- Button clicks (interactive) ---
          if (type === 'interactive' && msg.interactive?.type === 'button_reply') {
            const clicked = msg.interactive.button_reply?.id;
            if (clicked === 'shuffle') {
              const prior = lastPlayersByUser.get(from);
              if (!prior || prior.length !== 15) {
                await sendText(from,
                  `I don't have a saved 15-player roster yet.\n\nSend:\n` +
                  `teams: Alice, Bob, … (15 names)\n—or— paste your signup list.`
                );
                continue;
              }
              const teams = makeTeams(prior);
              await sendText(from, formatTeamsBlocks(teams));
              await sendButtons(from);
              continue;
            }
            if (clicked === 'help') {
              await sendText(from,
                `Paste a signup list of 15 or send:\n\n` +
                `teams: name1, name2, …, name15\n\n` +
                `I’ll split them into 🟡 YELLOW, 🔵 BLUE, 🔴 RED.\n` +
                `Use “Shuffle again” to reshuffle the same 15.`
              );
              continue;
            }
            // unknown button id -> ignore
            continue;
          }

          // --- Plain text messages ---
          if (type === 'text') {
            const bodyText = (msg.text?.body || '').trim();
            const names = parsePlayers(bodyText);

            if (names.length === 15) {
              lastPlayersByUser.set(from, names);
              const teams = makeTeams(names);
              await sendText(from, formatTeamsBlocks(teams));
              await sendButtons(from);
            } else {
              const count = names.length;
              const hint = count
                ? `I found ${count} name${count === 1 ? '' : 's'}. I need exactly 15.\n\n`
                : '';
              await sendText(from,
                `${hint}Examples:\n` +
                `• teams: Alice, Bob, Carlos, Diego, Eva, Faisal, Gita, Hasan, Irene, Jack, Kai, Luca, Mina, Noor, Omar\n` +
                `• Or paste your signup list (numbered lines are fine).`
              );
            }
            continue;
          }

          // Other message types (image, sticker, etc.) – gently ignore
          await sendText(from, 'Please send text with a 15-player list. 😊');
        }
      }
    }
  } catch (err) {
    console.error('Webhook handling error:', err?.response?.data || err);
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
