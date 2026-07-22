#!/bin/bash
# Copy to deploy/env.sh and fill in real values.
# Never commit deploy/env.sh.
export NODE_ENV=production
export SITE_BASE_URL=https://your-share.example.com
export SHARE_LINK_SECRET=your-share-link-secret
export WEBHOOK_SECRET=your-webhook-secret
export STATS_USER=admin
export STATS_PASS=change-me-stats-password
# Luma Plus API key (optional, for side-event registration)
export LUMA_API_KEY=
export GA_MEASUREMENT_ID=
