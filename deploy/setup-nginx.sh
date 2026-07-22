#!/bin/bash
# 仅用于「无宝塔 / 纯 Nginx」环境，会覆盖目标 conf 文件。
# 宝塔用户请勿运行！请在面板配置反向代理 → 127.0.0.1:3000
#
# 用法: SETUP_NGINX=1 bash deploy/setup-nginx.sh

set -e
cd "$(dirname "$0")/.."

if [ -d /www/server/panel ]; then
  echo "ERROR: 检测到宝塔面板，请勿用此脚本覆盖 Nginx 配置。"
  echo "       请在宝塔 → 网站 → your-share.example.com → 反向代理 → http://127.0.0.1:3000"
  exit 1
fi

export SETUP_NGINX=1
# shellcheck disable=SC1091
source deploy/deploy.sh 2>/dev/null || true

# deploy.sh 内 ensure_nginx_site 由 SETUP_NGINX 触发；若已拆出则直接调用：
if declare -f ensure_nginx_site >/dev/null 2>&1; then
  SETUP_NGINX=1 ensure_nginx_site
else
  echo "请使用: SETUP_NGINX=1 bash deploy/deploy.sh"
fi
