# luma-share-kit

**The missing share layer for Luma events.**

When someone registers on Luma, this kit:

1. Receives the webhook  
2. Sends a welcome email with a **personal invite link**  
3. Opens a share page with ready-to-post copy  
4. Generates OG / Instagram Story posters  

```text
Luma register  â†? webhook  â†? email  â†? share page  â†? X / LinkedIn / IG poster
```

Built for event organizers who want attendees to invite their network â€?without rebuilding this flow every time.

---

## Who this is for

- You're running a **Luma** event
- You want guests to get a **unique share link** after signup
- You want a page they can open and post in 30 seconds

Not a full ticketing system. Just the share / invite layer.

---

## Quick start (local)

**Requirements:** Node.js 18+

```bash
git clone https://github.com/jintao-dd/luma-share-kit.git
cd luma-share-kit
npm install

cp config.example.js config.js
# Minimum edits in config.js:
#   smtp.*              â†?your email
#   lumaEventUrl        â†?your Luma event
#   posterImageUrl      â†?HTTPS poster image
#   shareLinkSecret     â†?any long random string
#   webhookSecret       â†?any long random string

npm start
```

| Try this | URL |
|----------|-----|
| Health | http://localhost:3000/health |
| Stats | http://localhost:3000/stats.html |
| Webhook | `POST /api/luma-webhook` |

### Preview the share page

```bash
node sign-share-link.js admin-preview "Ada" "Your Org"
```

Open the printed URL. You should see the share UI with your poster and invite copy.

### Connect Luma (after you have a public URL)

In Luma â†?Event â†?Webhooks:

```text
https://YOUR_DOMAIN/api/luma-webhook?secret=YOUR_WEBHOOK_SECRET
```

Or use header: `X-Webhook-Secret: YOUR_WEBHOOK_SECRET`

Simulate a registration:

```bash
bash deploy/simulate-webhook.sh
```

---

## What you get

| Piece | What it does |
|-------|----------------|
| Webhook API | Stores guests in SQLite |
| Welcome email | HTML + plain text, with share link |
| Signed links | `uid` + HMAC `sig` so links can't be forged |
| `share.html` | Copy-to-post messages for X / LinkedIn / etc. |
| Posters | Dynamic OG image + Instagram Story image |
| Stats | Simple dashboard (Basic Auth) |

Optional: side-session one-click join via Luma API (`lumaApiKey` + `sideEvents` in config).

---

## Configure

```bash
cp config.example.js config.js
cp deploy/env.example.sh deploy/env.sh   # production secrets
```

**Never commit** `config.js` or `deploy/env.sh`.

| Must set | Why |
|----------|-----|
| `smtp.*` | Send welcome email |
| `siteBaseUrl` | Public URL of this service |
| `lumaEventUrl` | Ticket / event link on the share page |
| `posterImageUrl` | Main share / OG art (HTTPS) |
| `shareLinkSecret` | Sign personal links |
| `webhookSecret` | Auth Luma callbacks |

| Nice to have | Why |
|--------------|-----|
| `instagramStoryPosterImageUrl` | IG Story poster base |
| `gaMeasurementId` | GA4 |
| `lumaCouponCode` | Append `?coupon=` to invite links |
| `lumaApiKey` | Side-event auto-register |

Full field list: [`config.example.js`](config.example.js)

---

## Customize for your event

| File | Change this |
|------|-------------|
| `version.js` | Default share messages, poster slogan |
| `email-content.js` | Welcome email wording |
| `config.js` | Posters, event URL, mail subject, branding assets |

Search for `Your Event` / `Your Org` / `YourHost` and replace with your names.

---

## Deploy

Short version:

```bash
cp deploy/env.example.sh deploy/env.sh   # fill secrets
cp config.example.js config.js           # fill event config
npm install --production
pm2 start ecosystem.config.js
```

Nginx example: [`deploy/nginx-example.conf`](deploy/nginx-example.conf)  
Full notes: [`deploy/DEPLOY.md`](deploy/DEPLOY.md)

---

## Security

- Don't commit secrets (`config.js`, `deploy/env.sh`)
- Set strong `SHARE_LINK_SECRET` and `WEBHOOK_SECRET` in production
- Change the stats dashboard password (`STATS_PASS`)
- Use HTTPS in production

---

## License

MIT
