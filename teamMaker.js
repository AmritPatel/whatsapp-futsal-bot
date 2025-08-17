// teamMaker.js
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Input: array of 15 strings (player names)
 * Output: [TeamA(5), TeamB(5), TeamC(5)]
 */
function makeThreeTeamsOfFive(players) {
  if (!Array.isArray(players)) throw new Error("players must be an array");
  const names = players.map(s => String(s).trim()).filter(Boolean);
  if (names.length !== 15) throw new Error("Need exactly 15 players");
  const unique = [...new Set(names)];
  if (unique.length !== 15) throw new Error("Duplicate names detected");

  const dealt = shuffle(unique);
  return [dealt.slice(0, 5), dealt.slice(5, 10), dealt.slice(10, 15)];
}

module.exports = { makeThreeTeamsOfFive };
