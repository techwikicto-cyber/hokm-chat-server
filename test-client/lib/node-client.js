'use strict';
/**
 * کلاینت سوکت برای اجرا در Node — همان اینترفیسی را دارد که سناریوها انتظار دارند.
 *
 * نسخه کلاینت socket.io بر اساس نتیجه handshake انتخاب می‌شود:
 * کلاینت v2 فقط با سرور v2 حرف می‌زند و کلاینت v4 فقط با v3/v4.
 */

const { EncryptJson, DecryptJson } = require('./crypto');

// هر دو نسخه کلاینت در package.json با alias نصب می‌شوند
function LoadSocketIoClient(serverMajor) {
  const pkg = serverMajor >= 3 ? 'socket.io-client-v4' : 'socket.io-client-v2';
  try {
    const mod = require(pkg);
    return mod.io || mod.default || mod;
  } catch (err) {
    throw new Error(
      `کتابخانه «${pkg}» نصب نیست. داخل پوشه test-client این را اجرا کنید:\n` +
      `  npm install\n` +
      `یا از ایمیج داکر استفاده کنید که از قبل نصبش دارد.\n` +
      `(برای عیب‌یابی شبکه بدون تست‌های فانکشنال، --diagnose کافی است و هیچ پکیجی نمی‌خواهد.)`
    );
  }
}

class NodeChatClient {
  /**
   * @param {object} opts
   *   id, url, key, serverMajor, timeout, onLog(entry)
   */
  constructor(opts) {
    this.id = opts.id;
    this.url = opts.url;
    this.key = opts.key;
    this.serverMajor = opts.serverMajor;
    this.timeout = opts.timeout || 10000;
    this.onLog = opts.onLog || (() => {});
    this.details = opts.details || {};
    this.socket = null;
    this.waiters = new Set();
    this.chain = Promise.resolve();
    this.decryptFailures = 0;
    this._decryptFailWaiters = [];
  }

  // اگر سرور جواب بدهد ولی رمزگشایی نشود، یعنی کلید AES اشتباه است —
  // این را زود می‌فهمیم به‌جای این‌که همه تست‌ها یکی‌یکی تایم‌اوت بخورند.
  onDecryptFailure() {
    return new Promise((resolve) => this._decryptFailWaiters.push(resolve));
  }

  log(kind, title, body) {
    this.onLog({ client: this.id, kind, title, body, at: new Date() });
  }

  connect() {
    const io = LoadSocketIoClient(this.serverMajor);
    this.log('sys', `در حال اتصال به ${this.url} …`);

    this.socket = io(this.url, {
      forceNew: true,
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: this.timeout
    });

    this.socket.on('get_data', (raw) => this.handleGetData(raw));
    this.socket.on('disconnect', (reason) => this.log('sys', 'قطع شد: ' + reason));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`کلاینت ${this.id}: اتصال سوکت بعد از ${this.timeout}ms برقرار نشد`));
      }, this.timeout);

      this.socket.on('connect', () => {
        clearTimeout(timer);
        this.transport = this.currentTransport();
        this.log('sys', `متصل شد → socket id = ${this.socket.id}، transport = ${this.transport}`);
        resolve();
      });
      this.socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(new Error(`کلاینت ${this.id}: connect_error — ${err && err.message ? err.message : err}`));
      });
    });
  }

  isConnected() { return !!(this.socket && this.socket.connected); }

  // چت کاملاً روی سوکت است، نه درخواست/پاسخ HTTP. این می‌گوید عملاً روی کدام
  // transport نشسته‌ایم: websocket یا polling (که fallback روی HTTP است).
  currentTransport() {
    try {
      return this.socket.io.engine.transport.name;
    } catch (e) {
      return 'unknown';
    }
  }

  close() {
    if (this.socket) { this.socket.close ? this.socket.close() : this.socket.disconnect(); this.socket = null; }
  }

  handleGetData(raw) {
    // رمزگشایی را زنجیره می‌کنیم تا ترتیب لاگ حفظ شود
    this.chain = this.chain.then(() => {
      if (!raw || typeof raw.data !== 'string') {
        return this.log('err', 'get_data بدون فیلد data', raw);
      }
      let payload;
      try {
        payload = DecryptJson(raw.data, this.key);
      } catch (err) {
        this.decryptFailures++;
        this._decryptFailWaiters.splice(0).forEach(resolve => resolve(err));
        return this.log('err', 'رمزگشایی ناموفق — کلید AES اشتباه است؟ (' + err.message + ')', raw.data);
      }
      this.log(payload && payload.type === 'error' ? 'err' : 'in', '← get_data', payload);
      this.waiters.forEach(w => w(payload));
    }).catch(err => this.log('err', 'خطای داخلی: ' + err.message));
  }

  waitFor(predicate, label, timeout) {
    const ms = timeout || this.timeout;
    return new Promise((resolve, reject) => {
      const waiter = (payload) => {
        let matched = false;
        try { matched = predicate(payload); } catch (e) { matched = false; }
        if (matched) { cleanup(); resolve(payload); }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`کلاینت ${this.id}: تایم‌اوت در انتظار «${label}»`));
      }, ms);
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(waiter); };
      this.waiters.add(waiter);
    });
  }

  // ارسال رمزشده
  async sendRaw(event, payload) {
    if (!this.isConnected()) throw new Error(`کلاینت ${this.id} متصل نیست`);
    this.log('out', '→ ' + event, payload);
    this.socket.emit(event, EncryptJson(payload, this.key));
  }

  // ارسال خام و بدون رمزنگاری — فقط برای تست مقاومت سرور به ورودی خراب
  emitRaw(event, rawString) {
    if (!this.isConnected()) throw new Error(`کلاینت ${this.id} متصل نیست`);
    this.log('out', '→ ' + event + ' (خام و رمزنشده)', rawString);
    this.socket.emit(event, rawString);
  }

  rotateUserId() {
    const suffix = Math.random().toString(36).slice(2, 8);
    this.details.user_id = `${String(this.id).toLowerCase()}_${suffix}`;
    return this.details.user_id;
  }

  async sendUserDetails() {
    const promise = this.waitFor(p => p && p.type === 'get_privious_public_chats', 'get_privious_public_chats');
    await this.sendRaw('get_user_details', this.details);
    return promise;
  }

  async joinRoom(roomName) {
    if (!roomName) throw new Error('نام اتاق خالی است');
    const promise = this.waitFor(p => p && p.type === 'get_privious_private_chats', 'get_privious_private_chats');
    await this.sendRaw('join_chat_room', { room_name: roomName });
    return promise;
  }

  async sendMessage(roomName, message) {
    if (!roomName) throw new Error('نام اتاق خالی است');
    // سرور با socket.to(room) پخش می‌کند، پس فرستنده پیام خودش را دریافت نمی‌کند
    await this.sendRaw('send_chat_message', { room_name: roomName, message });
  }
}

module.exports = { NodeChatClient, LoadSocketIoClient };
