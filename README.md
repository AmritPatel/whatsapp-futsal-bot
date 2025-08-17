# WhatsApp Futsal Bot (3x5 Teams)

A tiny Node/Express webhook that turns a WhatsApp DM into 3 balanced teams of 5 using your futsal player list.

> Works with the **WhatsApp Cloud API** (Meta). You DM the bot a list; it replies with Teams A/B/C. Then you forward the message to your group.

---

## 0) Prereqs

- Node 18+ installed
- A Meta Developer account (free)
- WhatsApp Cloud API set up with a **Test number**, **Phone Number ID**, and **Access Token**

Meta docs:
- Cloud API overview: https://developers.facebook.com/docs/whatsapp/cloud-api/
- Messages endpoint: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages/
- Webhooks setup: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/
- Echo bot on Render (optional): https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-whatsapp-echo-bot/

---

## 1) Download & install

```bash
# unzip this folder, then:
cd whatsapp-futsal-bot
npm install
cp .env.example .env
```

Open `.env` and fill in:

- `VERIFY_TOKEN`: any string you choose (you'll type this again in Meta UI when verifying the webhook)
- `WHATSAPP_TOKEN`: your long-lived access token from Meta
- `PHONE_NUMBER_ID`: shown in WhatsApp > API Setup
- `GRAPH_API_VERSION`: default is v21.0; keep or bump if you know the latest
- `PORT`: default 3000

---

## 2) Run the server

```bash
npm run dev
# or
npm start
```

You should see: `Listening on 3000`

---

## 3) Expose your server to the internet (pick one)

### Option A: cloudflared (quick, no account)
```bash
# macOS (homebrew)
brew install cloudflare/cloudflare/cloudflared

# run a quick tunnel to your local server
cloudflared tunnel --url http://localhost:3000
```
Copy the `https://` URL it prints (something like `https://random.trycloudflare.com`).

### Option B: ngrok
```bash
# install and authenticate if needed
ngrok http 3000
```
Copy the `https://` forwarding URL.

---

## 4) Connect the webhook in Meta

1. Open **Meta for Developers → WhatsApp → Configuration**.
2. Set **Callback URL** to: `YOUR_HTTPS_URL/webhook`
3. Set **Verify Token** to the exact `VERIFY_TOKEN` from your `.env`
4. Click **Verify and Save**

Meta will call `GET /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` and your server will echo the challenge if the token matches.

Subscribe the app to **messages** events.

---

## 5) Test it

From your personal WhatsApp, DM your **test number** a message. Either:

**Comma-separated**
```
teams: Alice, Bob, Carlos, Diego, Eva, Faisal, Gita, Hasan, Irene, Jack, Kai, Luca, Mina, Noor, Omar
```

**Paste your signup list**
```
Sign up for Monday
1.Rajesh (Bibs)
2.Anish
3.Juan
4.Kunal
5.97
6.Sam
7.Pranab
8.Andreas
9.Elias
10. Anjal
11. Saugat
12. Simon
13. Kevin
14. Amrit
15. Nami
```

The bot will reply something like:
```
Teams for tonight:

A — Alice, Bob, Carlos, Diego, Eva
B — Faisal, Gita, Hasan, Irene, Jack
C — Kai, Luca, Mina, Noor, Omar

Have fun! ⚽
```

Forward that reply into your group chat.

---

## 6) Common gotchas

- **401 Unauthorized when sending** → your `WHATSAPP_TOKEN` is wrong/expired.
- **Webhook won’t verify** → `VERIFY_TOKEN` mismatch or your URL isn’t public HTTPS.
- **No replies** → make sure your app is subscribed to **messages** events.
- **Group posting** → Cloud API currently focuses on 1:1 messaging; share/forward results to your group.

---

## 7) How it works

- `server.js` exposes `/webhook` for GET (verification) and POST (incoming messages).
- `parser.js` accepts flexible input: `teams:` commands or pasted numbered lists (ignores `(Bibs)`, weird spaces, and numbering).
- `teamMaker.js` shuffles and deals 15 names into 3 teams of 5.
- Sends the reply using `POST /{PHONE_NUMBER_ID}/messages` on the Graph API.

Enjoy! ⚽
