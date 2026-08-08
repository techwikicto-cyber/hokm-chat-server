'use strict';
/**
 * همان رمزنگاری‌ای که سرور چت استفاده می‌کند: AES-256-CBC با IV تصادفی،
 * خروجی به شکل "<iv-hex>:<data-hex>".
 */

const crypto = require('crypto');

const IV_LENGTH = 16;

function ToKey(raw) {
  const key = Buffer.from(String(raw == null ? '' : raw), 'utf8');
  if (key.length !== 32) {
    throw new Error(`کلید AES باید دقیقاً ۳۲ بایت باشد (الان ${key.length} بایت است)`);
  }
  return key;
}

function EncryptData(text, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ToKey(key), iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function DecryptData(text, key) {
  const parts = String(text).split(':');
  if (parts.length !== 2) throw new Error('قالب داده رمزشده نامعتبر است (باید "iv:data" باشد)');

  const iv = Buffer.from(parts[0], 'hex');
  if (iv.length !== IV_LENGTH) throw new Error(`طول IV باید ${IV_LENGTH} بایت باشد (الان ${iv.length} است)`);

  const decipher = crypto.createDecipheriv('aes-256-cbc', ToKey(key), iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(parts[1], 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

function EncryptJson(payload, key) {
  return EncryptData(JSON.stringify(payload), key);
}

function DecryptJson(text, key) {
  return JSON.parse(DecryptData(text, key));
}

module.exports = { ToKey, EncryptData, DecryptData, EncryptJson, DecryptJson, IV_LENGTH };
