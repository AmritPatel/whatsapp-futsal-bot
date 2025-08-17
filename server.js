// server.js
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();

const { makeThreeTeamsOfFive } = require("./teamMaker");
const { parsePlayers, formatTeams } = require("./parser");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- env ---
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // any string you choose, must match in Meta UI
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // permanent or long-lived access token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // from WhatsApp > API Setup
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v21.0";

if (!VERIFY_TOKEN || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  console.error("Missing env vars. Check .env.example");
  process.exit(1);
}

// --- webhook verification (GET) ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- inbound messages (POST) ---
app.post("/webhook", async (req, res) => {
  console.log("INBOUND WEBHOOK:", JSON.stringify(req.body, null, 2));
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const messages = change?.value?.messages;
    if (!messages) {
      return res.sendStatus(200); // no user message (e.g., statuses)
    }

    for (const msg of messages) {
      if (msg.type !== "text" || !msg.text?.body) continue;
      const from = msg.from; // user phone in international format
      const text = msg.text.body.trim();

      let reply;
      try {
        const players = parsePlayers(text);
        const teams = makeThreeTeamsOfFive(players);
        reply = formatTeams(teams);
      } catch (e) {
        reply = e.message;
      }

      try {
        await axios.post(
          `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to: from,
            text: { body: reply }
          },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );
      } catch (sendErr) {
        console.error("send error", sendErr?.response?.data || sendErr.message);
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("webhook error", err?.response?.data || err.message);
    return res.sendStatus(500);
  }
});

// --- health ---
app.get("/", (_, res) => res.send("Futsal bot up"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
