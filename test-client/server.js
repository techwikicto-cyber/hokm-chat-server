#!/usr/bin/env node
/**
 * تستر مستقل چت سرور هکم
 *
 * این فایل هیچ ربطی به کد سرور چت ندارد و هیچ پکیجی هم لازم ندارد —
 * فقط Node. صفحه‌ای را روی لوکال بالا می‌آورد که در آن IP و پورت سرور چت
 * را وارد می‌کنید و دو کلاینت سوکت به آن وصل می‌شوند.
 *
 *   node test-client/server.js
 *   → http://localhost:8080
 *
 * پورت را با متغیر PORT عوض کنید: PORT=9000 node test-client/server.js
 *
 * رمزنگاری AES اینجا (سمت Node) انجام می‌شود، نه در مرورگر. دلیلش این است که
 * Web Crypto فقط روی HTTPS یا localhost کار می‌کند و اگر تستر را روی سرور
 * اجرا کنید و با http://IP بازش کنید، از کار می‌افتاد.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const IV_LENGTH = 16;

const INDEX_PATH = path.join(__dirname, 'index.html');

function EncryptData(text, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function DecryptData(text, key) {
  const [ivHex, dataHex] = String(text).split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedText = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

// کلید AES-256 باید دقیقاً ۳۲ بایت باشد — همان چیزی که سرور چت هم انتظار دارد
function ToKey(raw) {
  const key = Buffer.from(String(raw || ''), 'utf8');
  if (key.length !== 32) {
    throw new Error(`کلید AES باید دقیقاً ۳۲ کاراکتر باشد (الان ${key.length} است)`);
  }
  return key;
}

function ReadBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { req.destroy(); reject(new Error('payload too large')); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (err) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function SendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(INDEX_PATH, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('index.html پیدا نشد: ' + err.message);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'POST' && (url === '/api/encrypt' || url === '/api/decrypt')) {
    let body;
    try { body = await ReadBody(req); }
    catch (err) { return SendJson(res, 400, { error: err.message }); }

    let key;
    try { key = ToKey(body.key); }
    catch (err) { return SendJson(res, 400, { error: err.message }); }

    if (url === '/api/encrypt') {
      if (body.payload === undefined) return SendJson(res, 400, { error: 'payload لازم است' });
      try {
        return SendJson(res, 200, { data: EncryptData(JSON.stringify(body.payload), key) });
      } catch (err) {
        return SendJson(res, 500, { error: 'رمزگذاری ناموفق: ' + err.message });
      }
    }

    if (typeof body.data !== 'string') return SendJson(res, 400, { error: 'data لازم است' });
    let plain;
    try {
      plain = DecryptData(body.data, key);
    } catch (err) {
      return SendJson(res, 400, { error: 'رمزگشایی ناموفق — کلید AES اشتباه است؟' });
    }
    try {
      return SendJson(res, 200, { payload: JSON.parse(plain) });
    } catch (err) {
      return SendJson(res, 200, { payload: plain, note: 'خروجی JSON معتبر نبود' });
    }
  }

  SendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  تستر چت سرور هکم بالا آمد');
  console.log(`  → http://localhost:${PORT}`);
  console.log('');
  console.log('  در صفحه، آدرس سرور چت (مثلاً http://1.2.3.4:3008) و کلید AES را وارد کنید.');
  console.log('  برای بستن: Ctrl+C');
  console.log('');
});
