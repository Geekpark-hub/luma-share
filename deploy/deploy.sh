#!/bin/bash
# 生产服务器上执行（项目目录内）
# 用法: bash deploy/deploy.sh
#
# 自动处理：deploy/env.sh 的 SITE_BASE_URL、Nginx 站点、PM2 重启
# 跳过 Nginx：SKIP_NGINX=1 bash deploy/deploy.sh

set -e
cd "$(dirname "$0")/.."

DEPLOY_SCRIPT_REV="2026-07-07c"
# 固定生产域名，不受 shell / PM2 残留环境变量影响
CANONICAL_SITE="${SITE_BASE_URL:-https://your-share.example.com}"
SITE_PUBLIC="${CANONICAL_SITE}"
# Nginx example config (copy/rename for your domain when SETUP_NGINX=1)
NGINX_SRC="${NGINX_SRC:-deploy/nginx-example.conf}"
LEGACY_NGINX_NAMES=""

echo "==> deploy script rev: ${DEPLOY_SCRIPT_REV}"
if [ -f version.js ]; then
  node -e "console.log('==> zip app version:', require('./version').APP_VERSION)"
fi

upsert_env_var() {
  local key="$1"
  local value="$2"
  local file="deploy/env.sh"
  local line="export ${key}=${value}"
  if [ ! -f "$file" ]; then
    return 1
  fi
  if grep -q "^export ${key}=" "$file"; then
    sed -i "s|^export ${key}=.*|${line}|" "$file"
  else
    echo "$line" >> "$file"
  fi
}

ensure_env_file() {
  if [ -f deploy/env.sh ]; then
    echo "==> 同步 deploy/env.sh（SITE_BASE_URL → ${SITE_PUBLIC}）"
    upsert_env_var NODE_ENV production
    upsert_env_var SITE_BASE_URL "${SITE_PUBLIC}"
    return 0
  fi

  if [ -f deploy/env.example.sh ]; then
    echo "==> deploy/env.sh 不存在，从 env.example.sh 复制（请确认密钥已填写）"
    cp deploy/env.example.sh deploy/env.sh
    upsert_env_var SITE_BASE_URL "${SITE_PUBLIC}"
    return 0
  fi

  echo "WARN: 未找到 deploy/env.sh，将使用默认 SITE_BASE_URL=${SITE_PUBLIC}"
}

detect_nginx_sites_dir() {
  if [ -n "${NGINX_SITES_DIR:-}" ] && [ -d "$NGINX_SITES_DIR" ]; then
    echo "$NGINX_SITES_DIR"
    return 0
  fi
  for dir in \
    /etc/nginx/sites-available \
    /www/server/panel/vhost/nginx \
    /usr/local/nginx/conf/vhost
  do
    if [ -d "$dir" ]; then
      echo "$dir"
      return 0
    fi
  done
  return 1
}

ensure_nginx_site() {
  if [ "${SETUP_NGINX:-}" != "1" ]; then
    echo "==> 跳过 Nginx（宝塔/手动配置请保持现状；需脚本安装请 SETUP_NGINX=1）"
    return 0
  fi

  if [ "${SKIP_NGINX:-}" = "1" ]; then
    echo "==> 跳过 Nginx（SKIP_NGINX=1）"
    return 0
  fi

  if [ ! -f "$NGINX_SRC" ]; then
    echo "WARN: 未找到 ${NGINX_SRC}，跳过 Nginx"
    return 0
  fi

  local sites_dir
  if ! sites_dir="$(detect_nginx_sites_dir)"; then
    echo "WARN: 未检测到 Nginx 配置目录，跳过 Nginx（可设 NGINX_SITES_DIR）"
    return 0
  fi

  local target="${sites_dir}/${NGINX_CONF_NAME}.conf"
  echo "==> 安装 Nginx 配置 → ${target}"
  cp "$NGINX_SRC" "$target"

  if [ -d /etc/nginx/sites-enabled ]; then
    ln -sf "$target" "/etc/nginx/sites-enabled/${NGINX_CONF_NAME}.conf"
    for legacy in $LEGACY_NGINX_NAMES; do
      rm -f "/etc/nginx/sites-enabled/${legacy}.conf"
    done
  fi

  if command -v nginx >/dev/null 2>&1; then
    if nginx -t 2>/dev/null; then
      if command -v systemctl >/dev/null 2>&1; then
        systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
      else
        nginx -s reload 2>/dev/null || true
      fi
      echo "    Nginx 已 reload"
    else
      echo "WARN: nginx -t 失败，请检查 DNS / 证书后手动 reload"
    fi
  elif command -v /etc/init.d/nginx >/dev/null 2>&1; then
    /etc/init.d/nginx reload 2>/dev/null || true
  else
    echo "WARN: 未找到 nginx 命令；若用宝塔面板，请在面板重载配置"
  fi
}

ensure_env_file

if [ -f deploy/env.sh ]; then
  echo "==> loading deploy/env.sh"
  set -a
  # shellcheck disable=SC1091
  source deploy/env.sh
  set +a
fi

# 无论 env.sh / shell 里是什么，生产域名始终写死为 canonical
SITE_PUBLIC="${CANONICAL_SITE}"
if [ -f deploy/env.sh ]; then
  upsert_env_var SITE_BASE_URL "${SITE_PUBLIC}"
fi
export SITE_BASE_URL="${SITE_PUBLIC}"

if [ ! -f config.js ]; then
  echo "==> config.js 不存在，从 config.example.js 复制（请编辑 SMTP/密钥）"
  cp config.example.js config.js
fi

if [ "${NODE_ENV:-production}" = "production" ] && grep -q 'testMode: true' config.js 2>/dev/null; then
  echo "ERROR: config.js 中 testMode 仍为 true，生产环境请改为 false"
  exit 1
fi

if ! grep -q 'seedRegistrant' config.js 2>/dev/null; then
  echo "WARN: config.js 缺少 seedRegistrant，看板「分享页预览」将无法使用"
fi

ensure_nginx_site

echo "==> npm install --production"
npm install --production

echo "==> pm2 restart（清理本项目旧进程，只保留 luma-webhook）"
# 勿删 app — 同机 about.example.com 等其它站点可能占用该 PM2 名
for stale in server sharegpk luma-webhook; do
  if pm2 describe "$stale" >/dev/null 2>&1; then
    echo "    删除进程: $stale"
    pm2 delete "$stale" 2>/dev/null || true
  fi
done
pm2 start ecosystem.config.js
pm2 save

echo "==> health check (local)"
sleep 2
curl -sf "http://127.0.0.1:3000/health" | head -c 200
echo ""
node -e "console.log('  App version:', require('./version').APP_VERSION)"

echo "==> verify og:image"
curl -sf "http://127.0.0.1:3000/i/admin-preview" \
  | grep -o 'property="og:image" content="[^"]*"' \
  | head -1 || echo "WARN: 未抓到 og:image"

echo ""
echo "Done."
echo "  Site:    ${SITE_PUBLIC}"
if [ -n "${WEBHOOK_SECRET:-}" ]; then
  echo "  Webhook: ${SITE_PUBLIC}/api/luma-webhook"
  echo "           Header: X-Webhook-Secret: (see deploy/env.sh)"
else
  echo "  Webhook: ${SITE_PUBLIC}/api/luma-webhook"
  echo "           Header: X-Webhook-Secret: YOUR_WEBHOOK_SECRET"
fi
echo "  Stats:   ${SITE_PUBLIC}/stats.html"
echo ""
echo "  请在 Luma 后台把 Webhook URL 改为："
echo "  ${SITE_PUBLIC}/api/luma-webhook?secret=你的WEBHOOK_SECRET"
