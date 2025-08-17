// parser.js

// Zero-width and weird spaces we sometimes see copied from WhatsApp/Notes
const WEIRD_SPACES = /[\u200B-\u200D\uFEFF\u00A0]/g;

/**
 * Primary entry: try strict command first, then loose list fallback.
 * Returns exactly 15 names or throws an Error with a friendly message.
 */
function parsePlayers(text) {
  if (!text) throw new Error("Empty message");

  // Normalize whitespace weirdness
  const cleaned = text.replace(WEIRD_SPACES, "").trim();

  // 1) strict command: "teams:" / "3x5:" / "teams3:"
  const maybeStrict = tryStrictTrigger(cleaned);
  if (maybeStrict) return maybeStrict;

  // 2) loose: numbered list, headings, parentheses notes, bullets, etc.
  const maybeLoose = tryLooseList(cleaned);
  if (maybeLoose) return maybeLoose;

  throw new Error(
    "I couldn’t find 15 names.\n\n" +
    "Try either:\n" +
    "• `teams: name1, name2, ... name15`\n" +
    "• or paste a 1–15 list (I’ll ignore headings and numbering)."
  );
}

function tryStrictTrigger(text) {
  const trigger = /^(teams|3x5|teams3)\s*:?\s*/i;
  if (!trigger.test(text)) return null;
  const body = text.replace(trigger, "");

  // Accept comma- or newline-separated
  const looksComma = body.includes(",");
  const parts = looksComma
    ? body.split(",")
    : body.split(/\r?\n/);

  const names = parts.map(cleanName).filter(Boolean);
  return validateNames(names);
}

function tryLooseList(text) {
  // Split by lines; remove obvious headings like "Sign up for Monday"
  const lines = text.split(/\r?\n/);

  const candidateNames = [];
  for (let raw of lines) {
    let line = (raw || "").replace(WEIRD_SPACES, "").trim();
    if (!line) continue;

    // Skip common headings
    if (/^sign\s*up\b/i.test(line)) continue;

    // Remove leading numbering: "1.", "2)", "3 -", "10.", etc.
    line = line.replace(/^\s*\d+\s*[\.\)\-:]*\s*/, "");

    // If line turned blank after numbering removal, skip
    if (!line) continue;

    // Remove trailing notes in parentheses e.g., "Rajesh (Bibs)"
    // Keep content if the ENTIRE token is parentheses-only (rare)
    line = line.replace(/\s*\([^)]*\)\s*$/, "");

    // Remove leading bullets or dashes
    line = line.replace(/^[\-\*\u2022]\s*/, "");

    // Now line should be a name-like token.
    // Allow numbers like "97" as names; trim again for safety.
    const name = cleanName(line);
    if (name) candidateNames.push(name);
  }

  return validateNames(candidateNames);
}

function cleanName(s) {
  if (!s) return "";
  // Collapse internal whitespace to single spaces, trim
  let name = String(s).replace(/\s+/g, " ").trim();

  // Reject pure decoration lines
  if (!name) return "";

  // If something like "1." or "(Bibs)" slipped through, ignore
  if (/^\(\s*[^)]*\s*\)$/.test(name)) return "";

  return name;
}

function validateNames(names) {
  const filtered = names.filter(Boolean);
  if (filtered.length !== 15) return null;

  // Deduplicate while preserving order
  const seen = new Set();
  const unique = [];
  for (const n of filtered) {
    const key = n.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(n);
    }
  }

  if (unique.length !== 15) {
    throw new Error(
      `I found duplicates. I need 15 unique names. Got ${filtered.length} names but ${unique.length} unique.`
    );
  }

  return unique;
}

function formatTeams([A, B, C]) {
  const fmt = t => t.join(", ");
  return (
`Teams for tonight:

A — ${fmt(A)}
B — ${fmt(B)}
C — ${fmt(C)}

Have fun! ⚽`
  );
}

module.exports = { parsePlayers, formatTeams };
