#!/bin/bash
# 模拟 Luma 真实 Webhook（入库 + 发欢迎邮件）
#
# 用法:
#   bash deploy/simulate-webhook.sh 收件邮箱@example.com
#   bash deploy/simulate-webhook.sh 收件邮箱@example.com "张三"
#   bash deploy/simulate-webhook.sh --approval-flow 收件邮箱@example.com "李四"
#
# 在项目根目录执行；会自动加载 deploy/env.sh

set -e
cd "$(dirname "$0")/.."

if [ -f deploy/env.sh ]; then
  set -a
  # shellcheck disable=SC1091
  source deploy/env.sh
  set +a
fi

APPROVAL_FLOW=0
EMAIL=""
NAME="Webhook Sim User"
COMPANY="YourOrg"

while [ $# -gt 0 ]; do
  case "$1" in
    --approval-flow)
      APPROVAL_FLOW=1
      shift
      ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      if [ -z "$EMAIL" ]; then
        EMAIL="$1"
      elif [ "$NAME" = "Webhook Sim User" ]; then
        NAME="$1"
      else
        COMPANY="$1"
      fi
      shift
      ;;
  esac
done

if [ -z "$EMAIL" ]; then
  echo "用法: bash deploy/simulate-webhook.sh [--approval-flow] 邮箱 [姓名] [公司]"
  exit 1
fi

if [ -z "${WEBHOOK_SECRET:-}" ]; then
  echo "ERROR: 未设置 WEBHOOK_SECRET，请先配置 deploy/env.sh"
  exit 1
fi

SITE="${SITE_BASE_URL:-https://your-share.example.com}"
SITE="${SITE%/}"
EVENT_URL="https://luma.com/your-event-id"
TS=$(date +%s)
LUMA_UID="usr-sim-${TS}"
GUEST_ID="guest-${TS}"
WEBHOOK_URL="${LUMA_WEBHOOK_URL:-${SITE}/api/luma-webhook}"

post_webhook() {
  local type="$1"
  local status="$2"
  local payload_file="/tmp/luma-sim-${TS}.json"

  cat > "$payload_file" << EOF
{
  "type": "${type}",
  "data": {
    "id": "${GUEST_ID}",
    "user_id": "${LUMA_UID}",
    "user_email": "${EMAIL}",
    "user_name": "${NAME}",
    "user_first_name": "${NAME%% *}",
    "user_last_name": "${NAME#* }",
    "approval_status": "${status}",
    "utm_source": "luma",
    "registration_answers": [
      {
        "question_type": "company",
        "value": { "company": "${COMPANY}" }
      }
    ],
    "event": {
      "url": "${EVENT_URL}",
      "name": "Your Event 2026"
    }
  }
}
EOF

  echo "==> POST ${type} (${status})"
  echo "    邮箱: ${EMAIL}"
  echo "    uid:  ${LUMA_UID}"
  curl -s -X POST "${WEBHOOK_URL}" \
    -H "Content-Type: application/json" \
    -H "X-Webhook-Secret: ${WEBHOOK_SECRET}" \
    --data-binary "@${payload_file}"
  echo ""
}

echo "==> 模拟 Luma Webhook"
echo "    目标: ${WEBHOOK_URL%%\?*}"
echo ""

if [ "$APPROVAL_FLOW" = "1" ]; then
  post_webhook "guest.registered" "pending_approval"
  echo "    （待审核，此步不应发邮件）"
  sleep 2
  post_webhook "guest.updated" "approved"
  echo "    （审核通过，此步应发邮件）"
else
  post_webhook "guest.registered" "approved"
  echo "    （报名已通过，应发邮件）"
fi

echo ""
echo "==> 等待异步处理..."
sleep 3

SIG=$(node -e "
const { signShareUid } = require('./share-auth');
process.stdout.write(signShareUid('${LUMA_UID}'));
")

VERIFY=$(curl -s "${SITE}/api/verify-share-access?uid=${LUMA_UID}&sig=${SIG}")
echo "==> 校验分享页: ${VERIFY}"

if echo "$VERIFY" | grep -q '"valid":true'; then
  SHARE_LINK=$(node sign-share-link.js "${LUMA_UID}" "${NAME}" "${COMPANY}")
  echo ""
  echo "✓ 用户有效，分享页链接:"
  echo "  ${SHARE_LINK}"
  echo ""
  echo "请查收邮箱: ${EMAIL}"
  echo "（邮件链接与上面等价，请点邮件里的 View my sharing page）"
else
  echo ""
  echo "✗ 校验未通过，请查看日志:"
  echo "  pm2 logs luma-webhook --lines 40"
fi
