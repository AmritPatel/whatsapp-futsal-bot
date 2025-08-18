// server.js
// WhatsApp Futsal Bot — 3x5 team balancer + snake draft + Bibs tracker
// Features:
// - random mode, snake (rated or ranked)
// - vertical color blocks + buttons
// - balanced initial snake + non-repeating balanced shuffles (tier/tie shuffling)
// - team rating totals toggle via SHOW_TOTALS env (with decimal support)
// - Decimal ratings supported (e.g., 7.5 or 7,5)
// - Bibs tracker:
//     * Mark who actually took bibs last session by adding the word "bibs" anywhere on their line
//     * Track counts across sessions in a local JSON file (BIBS_FILE or ./bibs.json)
//     * On team post, show "Bibs next: <least so far among the 15> (tie→random; avoids repeating last washer)"
//     * Command "bibs_history" prints compact frequency chart (only people who have taken bibs)
//     * Idempotent recording (no double count on webhook retries)
//     * Only increments when the washer CHANGES from the last recorded washer
//
// Env required: VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID
// Optional: GRAPH_API_VERSION (defaults to v21.0), PORT, SHOW_TOTALS (default '1' → show), BIBS_FILE

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- Config ----------
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const PHONE_NUMBER_ID   = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN    = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;
const SHOW_TOTALS       = (process.env.SHOW_TOTALS ?? '1') === '1';

if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN || !VERIFY_TOKEN) {
  console.warn('[WARN] Missing one or more env vars: PHONE_NUMBER_ID, WHATSAPP_TOKEN, VERIFY_TOKEN');
}

const WA_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
const AUTH   = { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } };

// Idempotency: avoid double-incrementing bibs on webhook retries
const processedMessageIds = new Set();

// ---------- Tiny memory for "Shuffle again" ----------
/**
 * lastRosterByUser maps sender E.164 digits ->
 *   { mode: 'random'|'snake'|'snake_order',
 *     players: string[]                         // random or snake_order
 *            | {name:string, rating:number}[],  // snake (rated), DESC by rating
 *     lastKey?: string,                         // last composition signature
 *     seenKeys?: Set<string>,                   // all compositions sent for this roster
 *     bibsNext?: string,                        // cached assignment for next wash (stable across shuffles)
 *     ratingMap?: Map<string, number>           // for totals rendering on shuffles
 *   }
 */
const lastRosterByUser = new Map();

// ---------- Bibs store ----------
const BIBS_FILE = process.env.BIBS_FILE || path.join(process.cwd(), 'bibs.json');

function normalizeNameKey(name) {
  if (!name) return '';
  const lower = name.toLowerCase();
  const decomp = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return decomp.trim();
}

function readStore() {
  try {
    if (!fs.existsSync(BIBS_FILE)) return {};
    const raw = fs.readFileSync(BIBS_FILE, 'utf8');
    const data = JSON.parse(raw || '{}');
    return (data && typeof data === 'object') ? data : {};
  } catch (e) {
    console.error('[BIBS] load error:', e);
    return {};
  }
}
function writeStore(obj) {
  try {
    fs.writeFileSync(BIBS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('[BIBS] save error:', e);
  }
}
function incBibsCount(name) {
  const store = readStore();
  const key = normalizeNameKey(name);
  // Only increment when the washer CHANGES from the last recorded washer.
  if (store.__lastWasher === key) {
    return store[key] || 0;
  }
  store[key] = (store[key] || 0) + 1;
  store.__lastWasher = key; // remember last actual washer
  writeStore(store);
  return store[key];
}
function getBibsCount(name) {
  const store = readStore();
  const key = normalizeNameKey(name);
  return store[key] || 0;
}
function getBibsEntries() {
  const store = readStore();
  return Object.entries(store).filter(([k,_]) => !k.startsWith('__')); // [ [key, count], ... ]
}
function getLastWasherKey() {
  const store = readStore();
  return store.__lastWasher || null;
}

// ---------- Helpers: team formatting ----------
const COLORS = [
  { name: 'YELLOW', emoji: '🟡' }, // Team A
  { name: 'BLUE',   emoji: '🔵' }, // Team B
  { name: 'RED',    emoji: '🔴' }, // Team C
];

function formatTeamsBlocks(teams, totals, bibsNext, bibsTakenNote) {
  // teams = [ [5 names], [5 names], [5 names] ]
  const fmt = (x) => (Number.isFinite(x) ? (Number.isInteger(x) ? String(x) : x.toFixed(1)) : '');
  const blocks = teams.map((t, i) => {
    const header = `${COLORS[i].emoji}  ${COLORS[i].name}`;
    const body   = t.map(n => `• ${n}`).join('\n');
    const tail   = Array.isArray(totals) ? `\nTotal: ${fmt(totals[i])}` : '';
    return `${header}\n${body}${tail}`;
  });
  const bibsLine = bibsNext ? `\n🧼 Bibs next: ${bibsNext}` : '';
  const takenLine = bibsTakenNote ? `\n✅ Recorded: ${bibsTakenNote}` : '';
  return `Teams for tonight:\n\n${blocks.join('\n\n')}${bibsLine}${takenLine}\n\nHave fun! ⚽`;
}

// Composition signature invariant to within-team order AND color assignment.
function teamKey(teams) {
  const teamStrings = teams
    .map(t => t.slice().sort((a,b)=>a.localeCompare(b)).join('|'));
  teamStrings.sort();
  return teamStrings.join('||');
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
          { type: 'reply', reply: { id: 'bibs_history', title: 'Bibs history' } },
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

// Build a snake order with a chosen start team and optional reversed first round.
function buildSnakeOrder(startTeam = 0, reverseFirstRound = false) {
  const rounds = 5;
  const order = [];
  for (let r = 0; r < rounds; r++) {
    const forward = ((r % 2) === 0) ^ reverseFirstRound ? 1 : 0; // XOR
    const seq = forward ? [0,1,2] : [2,1,0];
    for (const t of seq) order.push((t + startTeam) % 3);
  }
  return order;
}

function makeTeamsSnakeWithOrder(sortedStrongToWeakNames, startTeam = 0, reverseFirstRound = false) {
  const order = buildSnakeOrder(startTeam, reverseFirstRound);
  const out = [[], [], []];
  for (let i = 0; i < 15; i++) {
    out[order[i]].push(sortedStrongToWeakNames[i]);
  }
  return out;
}

// ---- Balance evaluation helpers for snake ----
function computeTeamSums(teams, ratingMap) {
  return teams.map(team => team.reduce((sum, name) => sum + (ratingMap.get(name) || 0), 0));
}
function balanceScore(teams, ratingMap) {
  const sums = computeTeamSums(teams, ratingMap);
  const maxSum = Math.max(...sums);
  const minSum = Math.min(...sums);
  const spread = maxSum - minSum;
  const mean = (sums[0] + sums[1] + sums[2]) / 3;
  const variance = sums.reduce((acc, s) => acc + (s - mean) ** 2, 0) / 3;
  return { spread, variance, sums };
}

// ---- Tier / tie shuffling to change compositions while keeping balance ----
function shuffleWithinEqualRatings(ratedPlayersDesc) {
  const out = [];
  let i = 0;
  while (i < ratedPlayersDesc.length) {
    const r = ratedPlayersDesc[i].rating;
    const group = [];
    while (i < ratedPlayersDesc.length && ratedPlayersDesc[i].rating === r) {
      group.push(ratedPlayersDesc[i]);
      i++;
    }
    const g = shuffle(group);
    out.push(...g);
  }
  return out;
}
function tierShuffleNames(names) {
  const out = [];
  for (let i = 0; i < 15; i += 3) {
    const chunk = names.slice(i, i + 3);
    out.push(...shuffle(chunk));
  }
  return out;
}
function bestBalancedSnakeForOrder(sortedNames, ratingMap) {
  let best = null;
  for (let startTeam = 0; startTeam < 3; startTeam++) {
    for (const reverseFirst of [false, true]) {
      const teams = makeTeamsSnakeWithOrder(sortedNames, startTeam, reverseFirst);
      const key = teamKey(teams);
      const { spread, variance, sums } = balanceScore(teams, ratingMap);
      const cand = { teams, key, spread, variance, sums, startTeam, reverseFirst };
      if (!best || cand.spread < best.spread || (cand.spread === best.spread && cand.variance < best.variance)) {
        best = cand;
      }
    }
  }
  return best;
}
function chooseNewBalancedSnake(sortedNamesBase, ratingMap, seenKeys, attempts = 60) {
  for (let a = 0; a < attempts; a++) {
    let candidateOrder = sortedNamesBase;
    if (Math.random() < 0.5) candidateOrder = tierShuffleNames(candidateOrder);
    const best = bestBalancedSnakeForOrder(candidateOrder, ratingMap);
    if (!seenKeys.has(best.key)) return best;
  }
  return bestBalancedSnakeForOrder(sortedNamesBase, ratingMap);
}

// ---------- Helpers: parsing ----------
/**
 * parseRoster(raw) detects either:
 *  - random roster of 15 names (free-form; supports numbered lines, "teams: a, b, ...")
 *  - snake roster (ranked), using numbers after names (no parentheses), e.g. "Rajesh 9" or "Rajesh 9.5"
 *  - snake roster (ranked), using order only after "snake:" prefix (no ratings)
 *
 * Returns:
 *  { mode: 'random', players: string[], bibsTagged: string[] }
 *  OR
 *  { mode: 'snake', players: {name:string, rating:number}[], bibsTagged: string[] }
 *  OR
 *  { mode: 'snake_order', players: string[], bibsTagged: string[] }
 */
function parseRoster(raw) {
  if (!raw) return { mode: 'random', players: [], bibsTagged: [] };

  let text = raw
    .replace(/[\u200B-\u200D\u2060]/g, '') // zero-widths
    .replace(/\r/g, '')
    .trim();

  let forcedSnake = false;
  const snakePrefix = text.match(/^snake(?:\s*draft)?\s*:\s*([\s\S]+)$/i);
  if (snakePrefix) {
    forcedSnake = true;
    text = snakePrefix[1];
  }

  const teamsColon = text.match(/^teams?\s*:\s*([\s\S]+)$/i);
  if (teamsColon) {
    const payload = teamsColon[1];
    let items = payload.split(',').map(s => s.trim()).filter(Boolean);
    if (items.length === 1) items = payload.split('\n').map(s => s.trim()).filter(Boolean);
    return buildRosterFromItems(items, forcedSnake);
  }

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return buildRosterFromItems(lines, forcedSnake);
}

function buildRosterFromItems(items, forcedSnake) {
  const plainNames = [];
  const rated = [];
  const bibsTagged = [];

  for (let raw of items) {
    let line = raw.trim();
    if (!line) continue;
    const hasBibs = /\bbibs\b/i.test(line);
    // strip leading numbering like "1.", "10 -", "3) ", "11) - "
    line = line.replace(/^\s*\d{1,3}\s*[\.\)\-:]?\s*/, '');
    // remove anything in parentheses (e.g., "(bibs)") and standalone 'bibs' tokens
    line = line.replace(/\((?:[^()]*)\)/gi, ' ');
    line = line.replace(/\bbibs\b/gi, ' ');
    // collapse multiple spaces
    line = line.replace(/\s{2,}/g, ' ').trim();

    // detect trailing rating without parentheses, allow decimals with '.' or ','
    const ratingMatch = line.match(/^(.+?)\s+(\d{1,2}(?:[.,]\d{1,2})?)$/);
    if (ratingMatch) {
      const candidateName = cleanName(ratingMatch[1]);
      const rating = parseFloat(String(ratingMatch[2]).replace(',', '.'));
      if (candidateName && Number.isFinite(rating)) {
        rated.push({ name: candidateName, rating });
        if (hasBibs) bibsTagged.push(candidateName);
      }
    } else {
      const n = cleanName(line);
      if (n) {
        plainNames.push(n);
        if (hasBibs) bibsTagged.push(n);
      }
    }
  }

  if (rated.length === items.length && rated.length > 0) {
    rated.sort((a, b) => b.rating - a.rating);
    return { mode: 'snake', players: rated, bibsTagged };
  }

  if (forcedSnake && rated.length === 0 && plainNames.length === 15) {
    return { mode: 'snake_order', players: plainNames, bibsTagged };
  }

  return { mode: 'random', players: plainNames, bibsTagged };
}

function cleanName(s) {
  if (!s) return '';
  let t = s.replace(/^[\W_]+|[\W_]+$/g, '').replace(/\s{2,}/g, ' ').trim();
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
                  `For snake: "snake: Rajesh 9.0, Anish 8.5, …" or "snake:" with ranked lines.\n` +
                  `Add the word "bibs" on the line of whoever washed last time to record it.`
                );
                continue;
              }

              if (prior.mode === 'random') {
                const teams = makeTeamsRandom(prior.players);
                prior.lastKey = teamKey(teams);
                prior.seenKeys = prior.seenKeys || new Set([prior.lastKey]);
                prior.seenKeys.add(prior.lastKey);
                lastRosterByUser.set(from, prior);
                await sendText(from, formatTeamsBlocks(teams, undefined, prior.bibsNext, null));
                await sendButtons(from);
                continue;
              }

              // Snake variants: choose a NEW, balanced composition via tier/tie shuffling
              let sortedNamesBase, ratingMap;
              if (prior.mode === 'snake') {
                sortedNamesBase = prior.players.map(p => p.name); // DESC by rating
                ratingMap = new Map(prior.players.map((p) => [p.name, p.rating]));
                if (Math.random() < 0.7) {
                  const shuffledWithinTies = shuffleWithinEqualRatings(prior.players);
                  sortedNamesBase = shuffledWithinTies.map(p => p.name);
                }
              } else {
                // snake_order: assign synthetic ratings 15..1 (strong->weak)
                sortedNamesBase = prior.players.slice();
                ratingMap = new Map(sortedNamesBase.map((n, i) => [n, 15 - i]));
              }

              prior.seenKeys = prior.seenKeys || new Set();
              const choice = chooseNewBalancedSnake(sortedNamesBase, ratingMap, prior.seenKeys, 80);
              prior.lastKey = choice.key;
              prior.seenKeys.add(choice.key);
              lastRosterByUser.set(from, prior);
              const totals = SHOW_TOTALS ? computeTeamSums(choice.teams, ratingMap) : undefined;
              await sendText(from, formatTeamsBlocks(choice.teams, totals, prior.bibsNext, null));
              await sendButtons(from);
              continue;
            }

            if (clicked === 'bibs_history') {
              const chart = renderBibsHistory();
              await sendText(from, chart);
              continue;
            }

            if (clicked === 'help') {
              await sendText(from,
                `Send exactly 15 players. Examples:\n\n` +
                `• Random: teams: Alice, Bob, Carlos, Diego, Eva, Faisal, Gita, Hasan, Irene, Jack, Kai, Luca, Mina, Noor, Omar\n` +
                `• Rated snake (no parentheses; decimals allowed): snake: Rajesh 9.0, Anish 8.5, Juan 8, Kunal 7, 97 7, Sam 7, ...\n` +
                `• Ranked snake (no ratings, order strongest→weakest):\n` +
                `  snake:\n  1.Rajesh\n  2.Anish\n  3.Juan\n  ...\n  15.Nami\n\n` +
                `Bibs tracker:\n` +
                `• To record last session's washer: include the word "bibs" anywhere on their line (e.g., "Amrit (bibs) 8" or "Amrit bibs 8").\n` +
                `• "bibs_history" shows how many times each person has washed.`
              );
              continue;
            }
            continue; // unknown button id
          }

          // --- Plain text messages ---
          if (type === 'text') {
            const bodyText = (msg.text?.body || '').trim();

            // Quick command: bibs_history
            if (/^bibs[_\s-]?history$/i.test(bodyText)) {
              const chart = renderBibsHistory();
              await sendText(from, chart);
              continue;
            }

            // Idempotency key for this inbound message (WhatsApp may retry)
            const msgId = msg.id || `${from}:${Date.now()}`;
            const canRecordBibs = !processedMessageIds.has(msgId);

            const roster = parseRoster(bodyText);

            // Record any bibs markers from this submission (who actually washed last time)
            let bibsTakenNote = null;
            if (canRecordBibs && roster.bibsTagged && roster.bibsTagged.length) {
              const unique = Array.from(new Set(roster.bibsTagged));
              const updates = unique.map(name => {
                const newCount = incBibsCount(name);
                return `${name} (${newCount})`;
              });
              bibsTakenNote = updates.join(', ');
              processedMessageIds.add(msgId);
            }

            if (roster.mode === 'snake') {
              if (roster.players.length !== 15) {
                await sendText(from,
                  `For rated snake draft, send exactly 15 names each with a rating (no parentheses; decimals OK).\n\n` +
                  `Example:\nsnake: Rajesh 9.0, Anish 8.5, Juan 8, Kunal 7, 97 7, Sam 7, Pranab 6.5, Andreas 6, Elias 6, Anjal 6, Saugat 5, Simon 5, Kevin 5, Amrit 4.5, Nami 3`
                );
                continue;
              }
              const namesSorted = roster.players.map(p => p.name); // strong->weak
              const ratingMap = new Map(roster.players.map((p) => [p.name, p.rating]));
              // First reply: choose balanced composition already
              const choice = bestBalancedSnakeForOrder(namesSorted, ratingMap);

              // Compute bibs next (least count among these 15; ties random; avoid last washer)
              const bibsNext = pickBibsNext(namesSorted);

              lastRosterByUser.set(from, {
                mode: 'snake',
                players: roster.players.slice(), // keep ratings
                lastKey: choice.key,
                seenKeys: new Set([choice.key]),
                bibsNext,
                ratingMap
              });
              const totals = SHOW_TOTALS ? computeTeamSums(choice.teams, ratingMap) : undefined;
              await sendText(from, formatTeamsBlocks(choice.teams, totals, bibsNext, bibsTakenNote));
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
              const namesSorted = roster.players.slice();
              const ratingMap = new Map(namesSorted.map((n, i) => [n, 15 - i])); // synthetic ratings
              const choice = bestBalancedSnakeForOrder(namesSorted, ratingMap);

              // Compute bibs next
              const bibsNext = pickBibsNext(namesSorted);

              lastRosterByUser.set(from, {
                mode: 'snake_order',
                players: namesSorted,
                lastKey: choice.key,
                seenKeys: new Set([choice.key]),
                bibsNext,
                ratingMap
              });
              const totals = SHOW_TOTALS ? computeTeamSums(choice.teams, ratingMap) : undefined;
              await sendText(from, formatTeamsBlocks(choice.teams, totals, bibsNext, bibsTakenNote));
              await sendButtons(from);
              continue;
            }

            // random mode
            const names = roster.players;
            if (names.length === 15) {
              const teams = makeTeamsRandom(names);

              // Compute bibs next
              const bibsNext = pickBibsNext(names);

              lastRosterByUser.set(from, {
                mode: 'random',
                players: names.slice(),
                lastKey: teamKey(teams),
                seenKeys: new Set([teamKey(teams)]),
                bibsNext
              });
              await sendText(from, formatTeamsBlocks(teams, undefined, bibsNext, bibsTakenNote));
              await sendButtons(from);
            } else {
              const count = names.length;
              const hint = count
                ? `I found ${count} name${count === 1 ? '' : 's'}. I need exactly 15.\n\n`
                : '';
              await sendText(from,
                `${hint}Examples:\n` +
                `• teams: Alice, Bob, Carlos, Diego, Eva, Faisal, Gita, Hasan, Irene, Jack, Kai, Luca, Mina, Noor, Omar\n` +
                `• Snake (rated): snake: Rajesh 9.0, Anish 8.5, Juan 8, Kunal 7, 97 7, ...\n` +
                `• Snake (ranked only):\n  snake:\n  1.Rajesh\n  2.Anish\n  3.Juan\n  ...\n  15.Nami\n\n` +
                `To record last session's washer, put the word "bibs" anywhere on their line (e.g., "Amrit (bibs) 8" or "Amrit bibs 8").`
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

// ---------- Bibs helpers ----------
function pickBibsNext(currentNames) {
  // Among current 15, choose least bibs count; tie → random among ties,
  // but avoid repeating the last recorded washer if there is another candidate.
  let min = Infinity;
  const buckets = new Map();
  for (const n of currentNames) {
    const c = getBibsCount(n);
    if (c < min) min = c;
    const arr = buckets.get(c) || [];
    arr.push(n);
    buckets.set(c, arr);
  }
  let candidates = buckets.get(min) || currentNames;
  const lastWasherKey = getLastWasherKey();
  const filtered = candidates.filter(n => normalizeNameKey(n) !== lastWasherKey);
  if (filtered.length) candidates = filtered;
  const idx = Math.floor(Math.random() * candidates.length);
  return candidates[idx];
}

function renderBibsHistory() {
  const entries = getBibsEntries()
    .filter(([_, count]) => (count || 0) > 0)
    .sort((a,b) => a[1] - b[1]);
  if (!entries.length) return 'No bibs history yet.';

  const lines = entries.map(([key, count]) => {
    const bar = '▮'.repeat(Math.min(20, count));
    return `${key} — ${count} ${bar}`;
  });
  return `Bibs history (who has washed):\n` + lines.join('\n');
}

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
