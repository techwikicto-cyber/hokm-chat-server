'use strict';
/**
 * عیب‌یابی لایه‌به‌لایه اتصال به سرور چت.
 *
 * هر لایه جدا تست می‌شود تا وقتی چیزی کار نمی‌کند، دقیقاً معلوم باشد کجا شکسته:
 *   DNS → TCP → HTTP → engine.io handshake → WebSocket upgrade → CORS
 *
 * هیچ پکیج بیرونی لازم ندارد؛ فقط ماژول‌های خود Node.
 */

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 8000;

function now() { return process.hrtime.bigint(); }
function msSince(start) { return Number(now() - start) / 1e6; }

function step(name) {
  return { name, ok: null, ms: null, detail: '', reason: '', data: {} };
}

// ===================== لایه ۱: DNS =====================
async function CheckDns(target) {
  const s = step('DNS');
  const host = target.hostname;

  if (net.isIP(host)) {
    s.ok = true;
    s.ms = 0;
    s.detail = `${host} یک IP است، نیازی به DNS نیست`;
    s.data.addresses = [host];
    return s;
  }

  const t0 = now();
  try {
    const records = await dns.promises.lookup(host, { all: true });
    s.ok = true;
    s.ms = msSince(t0);
    s.data.addresses = records.map(r => r.address);
    s.detail = `${host} → ${s.data.addresses.join(', ')}`;
  } catch (err) {
    s.ok = false;
    s.ms = msSince(t0);
    s.detail = err.message;
    s.reason = err.code === 'ENOTFOUND'
      ? 'این نام دامنه اصلاً resolve نمی‌شود. املای دامنه را چک کنید یا مستقیم از IP استفاده کنید.'
      : 'خطای DNS. تنظیمات resolver این ماشین را چک کنید (/etc/resolv.conf).';
  }
  return s;
}

// ===================== لایه ۲: TCP =====================
function CheckTcp(target, timeout) {
  return new Promise((resolve) => {
    const s = step('TCP');
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const t0 = now();
    const socket = new net.Socket();
    let settled = false;

    const done = (ok, detail, reason) => {
      if (settled) return;
      settled = true;
      s.ok = ok; s.ms = msSince(t0); s.detail = detail; s.reason = reason || '';
      socket.destroy();
      resolve(s);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => done(true, `پورت ${port} باز است و اتصال برقرار شد`));
    socket.once('timeout', () => done(false, `اتصال به ${target.hostname}:${port} بعد از ${timeout}ms تایم‌اوت شد`,
      'بسته‌ها بی‌پاسخ drop می‌شوند — تقریباً همیشه یعنی فایروال یا Security Group جلوی این پورت را گرفته. ' +
      'برخلاف «connection refused» که یعنی چیزی گوش نمی‌دهد، اینجا اصلاً جوابی برنمی‌گردد.'));
    socket.once('error', (err) => {
      const hints = {
        ECONNREFUSED: 'به پورت رسیدیم ولی هیچ سرویسی روی آن گوش نمی‌دهد. سرور چت بالا نیست، یا روی پورت دیگری است، یا فقط روی 127.0.0.1 بایند شده و از بیرون در دسترس نیست.',
        EHOSTUNREACH: 'مسیری به این هاست وجود ندارد — مشکل روتینگ شبکه.',
        ENETUNREACH:  'شبکه در دسترس نیست — از این ماشین اصلاً به آن مقصد راه نیست.',
        ECONNRESET:   'اتصال وسط کار reset شد — احتمالاً یک میانی (فایروال/پروکسی) قطعش می‌کند.'
      };
      done(false, `${err.code || 'خطا'}: ${err.message}`, hints[err.code] || '');
    });

    socket.connect(port, target.hostname);
  });
}

// ===================== درخواست HTTP ساده =====================
function Request(urlString, options, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = now();

    const req = lib.request(urlString, Object.assign({ timeout }, options), (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (body.length < 65536) body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body,
        ms: msSince(t0)
      }));
    });

    req.on('timeout', () => { req.destroy(new Error(`تایم‌اوت بعد از ${timeout}ms`)); });
    req.on('error', reject);
    if (options && options.body) req.write(options.body);
    req.end();
  });
}

// ===================== لایه ۳: HTTP =====================
async function CheckHttp(target, timeout) {
  const s = step('HTTP');
  const url = target.origin + '/';
  try {
    const res = await Request(url, { method: 'GET' }, timeout);
    s.ms = res.ms;
    s.data.status = res.status;
    s.data.server = res.headers.server || null;
    s.data.body = res.body.slice(0, 300);

    let health = null;
    try { health = JSON.parse(res.body); } catch (e) { /* JSON نیست */ }

    if (health && health.status === 'ok') {
      s.ok = true;
      s.data.health = health;
      s.detail = `HTTP ${res.status} — health سرور چت: pid=${health.pid} port=${health.port}`;
    } else {
      s.ok = true;
      s.detail = `HTTP ${res.status}` + (res.headers.server ? ` (server: ${res.headers.server})` : '');
      s.reason = 'پاسخ گرفتیم ولی شکل health سرور چت را ندارد. ممکن است به nginx یا سرویس دیگری وصل شده باشید نه مستقیم به سرور چت. ' +
        'این لزوماً خطا نیست — اگر پشت nginx هستید طبیعی است.';
    }
  } catch (err) {
    s.ok = false;
    s.detail = err.message;
    s.reason = 'TCP وصل شد ولی پاسخ HTTP نیامد. شاید سرویسِ آن پورت اصلاً HTTP نیست، یا HTTPS است و شما http:// زده‌اید.';
  }
  return s;
}

// ===================== لایه ۴: engine.io handshake =====================
// از روی شکل پاسخ می‌فهمیم سرور socket.io v2 است یا v3/v4 — چون کلاینت‌هایشان با هم حرف نمی‌زنند.
async function CheckEngineIo(target, timeout) {
  const s = step('engine.io');
  const url = `${target.origin}/socket.io/?EIO=4&transport=polling&t=${Date.now()}`;
  try {
    const res = await Request(url, { method: 'GET' }, timeout);
    s.ms = res.ms;
    s.data.status = res.status;

    if (res.status === 404) {
      s.ok = false;
      s.detail = 'HTTP 404 روی /socket.io/';
      s.reason = 'مسیر socket.io وجود ندارد. یا سرور چت روی این آدرس نیست، یا nginx مسیر /socket.io/ را پروکسی نمی‌کند.';
      return s;
    }

    const body = res.body || '';
    let handshake = null;

    // socket.io v2 پاسخ را با طول prefix می‌دهد: "97:0{...}"
    const v2 = body.match(/^\d+:0(\{.*?\})/);
    // socket.io v3/v4 مستقیم: "0{...}"
    const v4 = body.match(/^0(\{.*?\})(?:\d|$)/);

    if (v2) {
      s.data.protocol = 3;
      s.data.serverMajor = 2;
      try { handshake = JSON.parse(v2[1]); } catch (e) {}
    } else if (v4) {
      s.data.protocol = 4;
      s.data.serverMajor = 4;
      try { handshake = JSON.parse(v4[1]); } catch (e) {}
    }

    if (!handshake) {
      s.ok = false;
      s.detail = `پاسخ غیرمنتظره: ${body.slice(0, 160)}`;
      s.reason = 'این پاسخ شبیه handshake انجین socket.io نیست.';
      return s;
    }

    s.ok = true;
    s.data.sid = handshake.sid;
    s.data.upgrades = handshake.upgrades || [];
    s.data.pingInterval = handshake.pingInterval;
    s.detail = `socket.io v${s.data.serverMajor} (EIO=${s.data.protocol}) — sid=${handshake.sid}, ` +
      `upgrades=[${s.data.upgrades.join(',')}], pingInterval=${handshake.pingInterval}ms`;

    if (!s.data.upgrades.includes('websocket')) {
      s.reason = 'سرور ارتقا به websocket را اعلام نکرده؛ ارتباط روی polling می‌ماند که کندتر است.';
    }
  } catch (err) {
    s.ok = false;
    s.detail = err.message;
    s.reason = 'handshake انجام نشد.';
  }
  return s;
}

// ===================== لایه ۵: WebSocket upgrade =====================
// خیلی از مشکلات واقعی اینجاست: nginx بدون proxy_set_header Upgrade، ارتقا را می‌شکند.
function CheckWebSocket(target, sid, protocol, timeout) {
  return new Promise((resolve) => {
    const s = step('WebSocket');
    const t0 = now();
    const key = crypto.randomBytes(16).toString('base64');
    const eio = protocol || 4;
    const path = `/socket.io/?EIO=${eio}&transport=websocket` + (sid ? `&sid=${sid}` : '');
    const lib = target.protocol === 'https:' ? https : http;
    let settled = false;

    const done = (ok, detail, reason) => {
      if (settled) return;
      settled = true;
      s.ok = ok; s.ms = msSince(t0); s.detail = detail; s.reason = reason || '';
      resolve(s);
    };

    const req = lib.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path,
      method: 'GET',
      timeout,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
      }
    });

    req.on('upgrade', (res, socket) => {
      const expected = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      const accept = res.headers['sec-websocket-accept'];
      socket.destroy();

      if (accept === expected) {
        done(true, 'ارتقا به websocket موفق بود (HTTP 101)');
      } else {
        done(false, `کلید Sec-WebSocket-Accept نخواند (گرفتیم ${accept})`,
          'یک میانی پاسخ handshake را دستکاری کرده است.');
      }
    });

    req.on('response', (res) => {
      res.resume();
      done(false, `به‌جای 101 جواب HTTP ${res.statusCode} آمد`,
        'سرور یا پروکسی جلویش ارتقا به websocket را قبول نکرد. اگر nginx دارید، این دو خط را در بلاک location لازم دارید:\n' +
        '        proxy_set_header Upgrade $http_upgrade;\n' +
        '        proxy_set_header Connection "upgrade";\n' +
        '      بدون این‌ها ارتباط روی polling می‌افتد: کار می‌کند ولی کند و پرمصرف است.');
    });

    req.on('timeout', () => { req.destroy(); done(false, `ارتقا بعد از ${timeout}ms تایم‌اوت شد`,
      'درخواست upgrade بی‌پاسخ ماند — معمولاً یک پروکسی یا فایروال میانی آن را نگه داشته است.'); });
    req.on('error', (err) => done(false, err.message, 'ارتقا به websocket شکست خورد.'));
    req.end();
  });
}

// ===================== لایه ۶: CORS =====================
async function CheckCors(target, timeout) {
  const s = step('CORS');
  const url = `${target.origin}/socket.io/?EIO=4&transport=polling&t=${Date.now()}`;
  try {
    const res = await Request(url, { method: 'GET', headers: { Origin: 'http://tester.local' } }, timeout);
    s.ms = res.ms;
    const allow = res.headers['access-control-allow-origin'];
    s.data.allowOrigin = allow || null;

    if (allow) {
      s.ok = true;
      s.detail = `Access-Control-Allow-Origin: ${allow}`;
    } else {
      s.ok = true;
      s.detail = 'هدر Access-Control-Allow-Origin برنگشت';
      s.reason = 'برای این تستر مهم نیست (از Node وصل می‌شود، نه از مرورگر). ولی اگر کلاینت وب دارید که از دامنه دیگری وصل می‌شود، ' +
        'مرورگر جلویش را می‌گیرد. سرور فقط وقتی CORS را روشن می‌کند که IS_LOCAL برابر "true" نباشد.';
    }
  } catch (err) {
    s.ok = false;
    s.detail = err.message;
  }
  return s;
}

// ===================== لایه ۷: تأخیر =====================
async function CheckLatency(target, timeout, samples = 5) {
  const s = step('Latency');
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t0 = now();
    try {
      await new Promise((resolve, reject) => {
        const sock = new net.Socket();
        sock.setTimeout(timeout);
        sock.once('connect', () => { sock.destroy(); resolve(); });
        sock.once('timeout', () => { sock.destroy(); reject(new Error('timeout')); });
        sock.once('error', reject);
        sock.connect(Number(target.port || 80), target.hostname);
      });
      times.push(msSince(t0));
    } catch (e) { /* این نمونه را رد می‌کنیم */ }
  }

  if (!times.length) {
    s.ok = false;
    s.detail = 'هیچ نمونه‌ای موفق نشد';
    return s;
  }

  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  s.ok = true;
  s.ms = avg;
  s.data = { min: times[0], max: times[times.length - 1], avg, samples: times.length };
  s.detail = `min=${times[0].toFixed(1)}ms  avg=${avg.toFixed(1)}ms  max=${times[times.length - 1].toFixed(1)}ms  (${times.length} نمونه)`;
  if (avg > 300) s.reason = 'تأخیر بالاست. تست‌ها ممکن است کند باشند؛ اگر تایم‌اوت خوردید --timeout را زیاد کنید.';
  return s;
}

// ===================== اجرای همه لایه‌ها =====================
async function RunDiagnostics(urlString, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const target = new URL(urlString);
  const steps = [];

  const dnsStep = await CheckDns(target);
  steps.push(dnsStep);
  if (!dnsStep.ok) return { target: target.origin, steps, fatal: 'DNS' };

  const tcpStep = await CheckTcp(target, timeout);
  steps.push(tcpStep);
  if (!tcpStep.ok) return { target: target.origin, steps, fatal: 'TCP' };

  steps.push(await CheckLatency(target, timeout));

  const httpStep = await CheckHttp(target, timeout);
  steps.push(httpStep);

  const eioStep = await CheckEngineIo(target, timeout);
  steps.push(eioStep);
  if (!eioStep.ok) return { target: target.origin, steps, fatal: 'engine.io' };

  steps.push(await CheckWebSocket(target, eioStep.data.sid, eioStep.data.protocol, timeout));
  steps.push(await CheckCors(target, timeout));

  return {
    target: target.origin,
    steps,
    fatal: null,
    serverMajor: eioStep.data.serverMajor,
    protocol: eioStep.data.protocol,
    health: httpStep.data.health || null
  };
}

module.exports = { RunDiagnostics, Request };
