// server.js
// WhatsApp Futsal Bot — 3x5 team balancer with buttons + snake draft (ratings or ranked order)
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
/**
 * lastRosterByUser maps sender E.164 digits ->
 *   { mode: 'random'|'snake'|'snake_order',
 *     players: string[]                         // random or snake_order
 *            | {name:string, rating:number}[],  // snake (rated)
 *     reversed?: boolean                        // used for snake/snake_order to vary next shuffle
 *   }
 */
const lastRosterByUser = new Map();

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

function makeTeamsRandom(players15) {
  const s = shuffle(players15);
  return [s.slice(0, 5), s.slice(5, 10), s.slice(10, 15)];
}

function makeTeamsSnake(sortedStrongToWeakNames) {
  // Draft order across 15 picks: A,B,C, C,B,A, A,B,C, C,B,A, A,B,C
  const order = [0,1,2, 2,1,0, 0,1,2, 2,1,0, 0,1,2];
  const out = [[], [], []];
  for (let i = 0; i < 15; i++) {
    out[order[i]].push(sortedStrongToWeakNames[i]);
  }
  return out;
}

// ---------- Helpers: parsing ----------
/**
 * parseRoster(raw) detects either:
 *  - random roster of 15 names (free-form; supports numbered lines, "teams: a, b, ...")
 *  - snake roster (ranked), using numbers after names (no parentheses), e.g. "Rajesh 9"
 *  - snake roster (ranked), using order only after "snake:" prefix (no ratings)
 *
 * Returns:
 *  { mode: 'random', players: string[] }
 *  OR
 *  { mode: 'snake', players: {name:string, rating:number}[] }       // sorted strong->weak
 *  OR
 *  { mode: 'snake_order', players: string[] }                       // order is strongest->weakest
 */
function parseRoster(raw) {
  if (!raw) return { mode: 'random', players: [] };

  // Normalize zero-width & punctuation
  let text = raw
    .replace(/[\u200B-\u200D\u2060]/g, '') // zero-widths
    .replace(/\r/g, '')
    .trim();

  let forcedSnake = false;

  // Accept "snake:" or "snake draft:" prefixes (multiline capture)
  const snakePrefix = text.match(/^snake(?:\s*draft)?\s*:\s*([\s\S]+)$/i);
  if (snakePrefix) {
    forcedSnake = true;
    text = snakePrefix[1];
  }

  // Case A: "teams: a, b, c, ..." (also allow multiline after colon)
  const teamsColon = text.match(/^teams?\s*:\s*([\s\S]+)$/i);
  if (teamsColon) {
    const payload = teamsColon[1];
    // split by comma first; if only one item, fall back to newline split
    let items = payload.split(',').map(s => s.trim()).filter(Boolean);
    if (items.length === 1) {
      items = payload.split('\n').map(s => s.trim()).filter(Boolean);
    }
    return buildRosterFromItems(items, forcedSnake);
  }

  // Case B: Pasted signup list with numbers/notes per line
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return buildRosterFromItems(lines, forcedSnake);
}

function buildRosterFromItems(items, forcedSnake) {
  const plainNames = [];
  const rated = [];

  for (let raw of items) {
    let line = raw.trim();
    if (!line) continue;
    // strip leading numbering like "1.", "10 -", "3) ", "11) - "
    line = line.replace(/^\s*\d{1,3}\s*[\.\)\-:]?\s*/, '');
    // remove trailing/inline notes like "(Bibs)"
    line = line.replace(/\((?:[^()]*)\)/g, '');
    // collapse multiple spaces
    line = line.replace(/\s{2,}/g, ' ').trim();

    // detect trailing rating without parentheses, e.g. "Rajesh 9" or "Juan 10"
    const ratingMatch = line.match(/^(.+?)\s+(\d{1,2})$/);
    if (ratingMatch) {
      const candidateName = cleanName(ratingMatch[1]);
      const rating = parseInt(ratingMatch[2], 10);
      if (candidateName && isFinite(rating)) {
        rated.push({ name: candidateName, rating });
      }
    } else {
      const n = cleanName(line); // keep numeric-only names like "97"
      if (n) plainNames.push(n);
    }
  }

  // If every item had a rating => rated snake
  if (rated.length === items.length && rated.length > 0) {
    rated.sort((a, b) => b.rating - a.rating); // strong->weak
    return { mode: 'snake', players: rated };
  }

  // If user forced snake but gave only ranked names => use order as ranking
  if (forcedSnake && rated.length === 0 && plainNames.length === 15) {
    return { mode: 'snake_order', players: plainNames };
  }

  // Default: random list of names
  return { mode: 'random', players: plainNames };
}

function cleanName(s) {
  if (!s) return '';
  let t = s
    .replace(/^[\W_]+|[\W_]+$/g, '')   // trim non-word at ends
    .replace(/\s{2,}/g, ' ')
    .trim();
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

        // Handle only messages here
        const messages = v.messages || [];
        if (!messages.length) continue;

        for (const msg of messages) {
          const from = msg.from; // sender E.164 digits
          const type = msg.type;

          // --- Button clicks (interactive) ---
          if (type === 'interactive' && msg.interactive?.type === 'button_reply') {
            const clicked = msg.interactive.button_reply?.id;
            if (clicked === 'shuffle') {
              const prior = lastRosterByUser.get(from);
              if (!prior) {
                await sendText(from,
                  `I don't have a saved 15-player roster yet.\n\nSend:\n` +
                  `teams: Alice, Bob, … (15 names)\n—or— paste your signup list.\n\n` +
                  `For snake: "snake: Rajesh 9, Anish 8, …" or "snake:" with ranked lines.`
                );
                continue;
              }
              if (prior.mode === 'random') {
                const teams = makeTeamsRandom(prior.players);
                await sendText(from, formatTeamsBlocks(teams));
                await sendButtons(from);
              } else if (prior.mode === 'snake') {
                prior.reversed = !prior.reversed;
                const list = prior.reversed
                  ? prior.players.slice().reverse().map(p => p.name)
                  : prior.players.map(p => p.name);
                const teams = makeTeamsSnake(list);
                lastRosterByUser.set(from, prior);
                await sendText(from, formatTeamsBlocks(teams));
                await sendButtons(from);
              } else if (prior.mode === 'snake_order') {
                prior.reversed = !prior.reversed;
                const list = prior.reversed
                  ? prior.players.slice().reverse()
                  : prior.players.slice();
                const teams = makeTeamsSnake(list);
                lastRosterByUser.set(from, prior);
                await sendText(from, formatTeamsBlocks(teams));
                await sendButtons(from);
              }
              continue;
            }
            if (clicked === 'help') {
              await sendText(from,
                `Send exactly 15 players. Examples:\n\n` +
                `• Random: teams: Alice, Bob, Carlos, Diego, Eva, Faisal, Gita, Hasan, Irene, Jack, Kai, Luca, Mina, Noor, Omar\n` +
                `• Rated snake (no parentheses): snake: Rajesh 9, Anish 8, Juan 8, Kunal 7, 97 7, Sam 7, ...\n` +
                `• Ranked snake (no ratings, order strongest→weakest):\n` +
                `  snake:\n  1.Rajesh\n  2.Anish\n  3.Juan\n  ...\n  15.Nami`
              );
              continue;
            }
            continue; // unknown button id
          }

          // --- Plain text messages ---
          if (type === 'text') {
            const bodyText = (msg.text?.body || '').trim();
            const roster = parseRoster(bodyText);

            if (roster.mode === 'snake') {
              if (roster.players.length !== 15) {
                await sendText(from,
                  `For rated snake draft, send exactly 15 names each with a rating (no parentheses).\n\n` +
                  `Example:\nsnake: Rajesh 9, Anish 8, Juan 8, Kunal 7, 97 7, Sam 7, Pranab 6, Andreas 6, Elias 6, Anjal 6, Saugat 5, Simon 5, Kevin 5, Amrit 4, Nami 3`
                );
                continue;
              }
              const namesSorted = roster.players.map(p => p.name); // already strong->weak
              lastRosterByUser.set(from, { mode: 'snake', players: roster.players.slice(), reversed: false });
              const teams = makeTeamsSnake(namesSorted);
              await sendText(from, formatTeamsBlocks(teams));
              await sendButtons(from);
              continue;
            }

            if (roster.mode === 'snake_order') {
              if (roster.players.length !== 15) {
                await sendText(from,
                  `For ranked snake (no ratings), send exactly 15 names in strongest→weakest order after "snake:".\n\n` +
                  `Example:\nsnake:\n1.Rajesh\n2.Anish\n3.Juan\n4.Kunal\n5.97\n6.Sam\n7.Pranab\n8.Andreas\n9.Elias\n10.Anjal\n11.Saugat\n12.Simon\n13.Kevin\n14.Amrit\n15.Nami`
                );
                continue;
              }
              lastRosterByUser.set(from, { mode: 'snake_order', players: roster.players.slice(), reversed: false });
              const teams = makeTeamsSnake(roster.players);
              await sendText(from, formatTeamsBlocks(teams));
              await sendButtons(from);
              continue;
            }

            // random mode
            const names = roster.players;
            if (names.length === 15) {
              lastRosterByUser.set(from, { mode: 'random', players: names.slice() });
              const teams = makeTeamsRandom(names);
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
                `• Snake (rated): snake: Rajesh 9, Anish 8, Juan 8, Kunal 7, 97 7, ...\n` +
                `• Snake (ranked only):\n  snake:\n  1.Rajesh\n  2.Anish\n  3.Juan\n  ...\n  15.Nami`
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
