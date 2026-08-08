/**
 * صفحه تست چت (فقط برای بررسی دستی فانکشنالیتی سرور)
 *
 * این ماژول فقط زمانی روی اپ سوار می‌شود که ENABLE_TEST_PAGE=true باشد.
 * سه مسیر ارائه می‌دهد:
 *   GET  /test-chat            → صفحه HTML تستر
 *   GET  /test-chat/config     → تنظیمات غیرمحرمانه مورد نیاز صفحه
 *   POST /test-chat/encrypt    → رمزگذاری payload با همان AES کلاینت
 *   POST /test-chat/decrypt    → رمزگشایی پیام‌های دریافتی
 *
 * نکته امنیتی: کلید AES هرگز به مرورگر داده نمی‌شود؛ رمزنگاری سمت سرور انجام
 * می‌شود. با این حال هر کسی که به این مسیرها دسترسی داشته باشد می‌تواند پیام
 * معتبر بسازد، پس روی سرور عمومی حتماً TEST_PAGE_TOKEN را ست کنید.
 */

const path = require('path');

const config = require('../config');
const socketController = require('./socket-controller');

const TEST_PAGE_TOKEN = process.env.TEST_PAGE_TOKEN || '';

function CheckToken(req, res, next) {
  if (!TEST_PAGE_TOKEN) return next();

  const provided = req.query.token || req.headers['x-test-token'] || (req.body && req.body.token);
  if (provided === TEST_PAGE_TOKEN) return next();

  res.status(403).json({ error: 'invalid or missing test page token' });
}

exports.Register = function (app) {
  app.get('/test-chat', CheckToken, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'chat-test.html'));
  });

  app.get('/test-chat/config', CheckToken, (req, res) => {
    res.json({
      public_room_name: config.PUBLIC_ROOM_NAME,
      is_emoji_active: config.IS_EMOJI_ACTIVE,
      app_version: config.APP_VERSION,
      should_use_nginx_redis: config.SHOULD_USE_NGINX_REDIS,
      max_public_chats: config.MAXIMUM_PUBLIC_ROOM_CHATS_LENGTH,
      max_private_chats: config.MAXIMUM_PRIVATE_ROOM_CHATS_LENGTH,
      cooldown_seconds: 8,
      worker_pid: process.pid
    });
  });

  app.post('/test-chat/encrypt', CheckToken, (req, res) => {
    const payload = req.body && req.body.payload;
    if (payload === undefined) {
      return res.status(400).json({ error: 'payload is required' });
    }

    try {
      res.json({ data: socketController.EncryptData(JSON.stringify(payload)) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/test-chat/decrypt', CheckToken, (req, res) => {
    const data = req.body && req.body.data;
    if (typeof data !== 'string') {
      return res.status(400).json({ error: 'data is required' });
    }

    const plain = socketController.DecryptData(data);
    if (plain === null) {
      return res.status(400).json({ error: 'decryption failed' });
    }

    try {
      res.json({ payload: JSON.parse(plain) });
    } catch (err) {
      res.json({ payload: plain, note: 'payload is not valid JSON' });
    }
  });

  console.log(`[Worker ${process.pid}] Chat test page ENABLED → /test-chat${TEST_PAGE_TOKEN ? '?token=***' : ' (بدون توکن!)'}`);
};
