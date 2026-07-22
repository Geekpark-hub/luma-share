/**
 * PM2 进程管理配置
 * 启动：pm2 start ecosystem.config.js
 * 查看：pm2 logs luma-webhook
 *
 * 密钥通过 deploy/env.sh 注入（复制 deploy/env.example.sh 后填写，勿提交 git）
 */
module.exports = {
  apps: [
    {
      name: 'luma-webhook',
      script: 'server.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        SITE_BASE_URL: process.env.SITE_BASE_URL || 'https://your-share.example.com',
        SHARE_LINK_SECRET: process.env.SHARE_LINK_SECRET || '',
        WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
        STATS_USER: process.env.STATS_USER || 'admin',
        STATS_PASS: process.env.STATS_PASS || '',
        LUMA_API_KEY: process.env.LUMA_API_KEY || '',
      },
    },
  ],
};
