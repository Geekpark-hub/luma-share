# Deploy guide

## 1. Secrets

```bash
cp deploy/env.example.sh deploy/env.sh
# edit deploy/env.sh
```

Required:

| Variable | Purpose |
|----------|---------|
| `SITE_BASE_URL` | Public HTTPS origin, e.g. `https://share.example.com` |
| `SHARE_LINK_SECRET` | HMAC for `share.html?uid&sig` |
| `WEBHOOK_SECRET` | Luma webhook auth |
| `STATS_USER` / `STATS_PASS` | Stats dashboard Basic Auth |

Optional: `LUMA_API_KEY`, `GA_MEASUREMENT_ID`

Also create `config.js` from `config.example.js` (SMTP, posters, event URLs).

## 2. Run with PM2

```bash
npm install --production
pm2 start ecosystem.config.js
pm2 save
```

Health check:

```bash
curl -s https://your-share.example.com/health
```

## 3. Nginx

Example config: `deploy/nginx-example.conf`

- Reverse-proxy to Node (`127.0.0.1:3000` by default)
- Rate-limit `/og/*.jpg` if you expose OG image generation

On many panel hosts (宝塔 etc.) you can skip file install and configure reverse proxy in the UI:

```bash
SKIP_NGINX=1 bash deploy/deploy.sh
```

## 4. Luma webhook

```
https://your-share.example.com/api/luma-webhook?secret=YOUR_WEBHOOK_SECRET
```

Header alternative: `X-Webhook-Secret: YOUR_WEBHOOK_SECRET`

Simulate locally / against staging:

```bash
# source deploy/env.sh first
bash deploy/simulate-webhook.sh
```

## 5. Test email

```bash
node send-test-email.js you@example.com
```

## 6. Preview share page

```bash
node sign-share-link.js admin-preview "Admin Preview" "Your Org"
```

Open the printed URL.

## Checklist before going public

- [ ] `SHARE_LINK_SECRET` set and not empty
- [ ] `WEBHOOK_SECRET` matches Luma webhook config
- [ ] SMTP works from the server IP
- [ ] Poster image URLs are HTTPS and publicly reachable
- [ ] Stats password changed from the example default
