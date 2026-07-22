#!/bin/bash
# 带备份与快速回滚的生产部署（v1.4.66 better-sqlite3）
# 用法: bash deploy/deploy-with-rollback.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SITE_DIR="$(pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${SITE_DIR}/.rollback/${TS}"
ZIP="${SITE_DIR}/luma-webhook-deploy.zip"
ROLLBACK_SCRIPT="${SITE_DIR}/.rollback/ROLLBACK-${TS}.sh"

rollback_now() {
  local reason="${1:-deploy failed}"
  echo ""
  echo "==> ROLLBACK: ${reason}"
  if [ -x "$ROLLBACK_SCRIPT" ] || [ -f "$ROLLBACK_SCRIPT" ]; then
    bash "$ROLLBACK_SCRIPT"
  else
    echo "ERROR: rollback script missing: $ROLLBACK_SCRIPT"
    exit 1
  fi
}

mkdir -p "$BACKUP_DIR"
echo "==> Backup dir: $BACKUP_DIR"

# --- 1. 备份可回滚资产 ---
echo "==> 备份 config.js / db / 关键代码"
cp -a config.js "$BACKUP_DIR/config.js"
for f in luma_data.db luma_data.db-wal luma_data.db-shm; do
  [ -f "$f" ] && cp -a "$f" "$BACKUP_DIR/$f"
done
for f in package.json package-lock.json version.js server.js db.js ecosystem.config.js; do
  [ -f "$f" ] && cp -a "$f" "$BACKUP_DIR/$f"
done
[ -d node_modules ] && cp -a node_modules "$BACKUP_DIR/node_modules"

cat > "$ROLLBACK_SCRIPT" <<ROLLBACK
#!/bin/bash
set -euo pipefail
cd "${SITE_DIR}"
echo "==> 回滚到备份 ${TS}"
pm2 stop luma-webhook 2>/dev/null || true
cp -a "${BACKUP_DIR}/config.js" config.js
for f in luma_data.db luma_data.db-wal luma_data.db-shm; do
  [ -f "${BACKUP_DIR}/\$f" ] && cp -a "${BACKUP_DIR}/\$f" "\$f"
done
for f in package.json package-lock.json version.js server.js db.js ecosystem.config.js; do
  [ -f "${BACKUP_DIR}/\$f" ] && cp -a "${BACKUP_DIR}/\$f" "\$f"
done
if [ -d "${BACKUP_DIR}/node_modules" ]; then
  rm -rf node_modules
  cp -a "${BACKUP_DIR}/node_modules" node_modules
fi
pm2 start ecosystem.config.js
pm2 save
sleep 2
curl -sf "http://127.0.0.1:3000/health" | head -c 200 || true
echo ""
node -e "console.log('Rollback version:', require('./version').APP_VERSION)"
echo "==> 回滚完成。备份保留在 ${BACKUP_DIR}"
ROLLBACK
chmod +x "$ROLLBACK_SCRIPT"
echo "==> 回滚脚本: $ROLLBACK_SCRIPT"

if [ ! -f "$ZIP" ]; then
  echo "ERROR: 未找到 $ZIP"
  exit 1
fi

# --- 2. 停 PM2 ---
echo "==> 停止 PM2"
pm2 stop luma-webhook 2>/dev/null || true

# --- 3. 解压（zip 不含 config.js；若存在则跳过）---
echo "==> 解压新版本"
unzip -oq "$ZIP"
if [ -f config.js ]; then
  echo "==> 保留现有 config.js"
else
  echo "==> config.js 不存在，从 config.example.js 复制（请编辑密钥）"
  cp config.example.js config.js
fi

# --- 4. npm install + PM2 启动 ---
echo "==> npm install --production"
if ! npm install --production; then
  rollback_now "npm install failed"
fi

echo "==> pm2 start"
for stale in server sharegpk luma-webhook; do
  pm2 delete "$stale" 2>/dev/null || true
done
if [ -f deploy/env.sh ]; then
  set -a
  # shellcheck disable=SC1091
  source deploy/env.sh
  set +a
fi
if ! pm2 start ecosystem.config.js; then
  rollback_now "pm2 start failed"
fi
pm2 save

# --- 5. 健康检查 ---
echo "==> health check"
sleep 3
if ! curl -sf "http://127.0.0.1:3000/health" >/dev/null; then
  rollback_now "health check failed"
fi
HEALTH="$(curl -sf "http://127.0.0.1:3000/health" | head -c 300)"
echo "$HEALTH"
APP_VER="$(node -e "console.log(require('./version').APP_VERSION)")"
echo "==> App version: $APP_VER"

# DB smoke test
if ! node -e "
const db=require('./db');
db.initDatabase(require('./config').dbPath||'./luma_data.db').then(()=>{
  const s=db.getStats();
  if(s.overview._degraded) process.exit(2);
  db.closeDatabase();
}).catch(e=>{console.error(e);process.exit(1)});
"; then
  rollback_now "database smoke test failed"
fi

echo ""
echo "==> 部署成功 v${APP_VER}"
echo "    回滚命令: bash $ROLLBACK_SCRIPT"
echo "    备份目录: $BACKUP_DIR"
