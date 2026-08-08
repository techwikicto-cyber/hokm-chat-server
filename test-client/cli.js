#!/usr/bin/env node
'use strict';
/**
 * تستر چت سرور هکم — حالت خط فرمان.
 *
 * از هر ماشینی به سرور چت وصل می‌شود، لایه‌های شبکه را جدا جدا عیب‌یابی می‌کند،
 * بعد ۹ سناریو فانکشنال را اجرا می‌کند و گزارش می‌دهد. هیچ تغییری در سرور لازم ندارد.
 *
 *   node cli.js --url http://1.2.3.4:3008 --key <۳۲ کاراکتر>
 *   node cli.js --url http://1.2.3.4:3008 --diagnose      # فقط شبکه، بدون نیاز به npm install
 *
 * کد خروجی: 0 یعنی همه‌چیز سالم، 1 یعنی حداقل یک تست شکست خورده.
 */

const { RunDiagnostics } = require('./lib/diagnostics');
const { NodeChatClient } = require('./lib/node-client');
const { SCENARIOS } = require('./lib/scenarios');

// ===================== آرگومان‌ها =====================
const DEFAULTS = {
  url: process.env.CHAT_URL || '',
  key: process.env.AES_KEY || 'p2s5v8y/B?E(H+MbPeShVmYq3t6w9z$C',
  room: process.env.PUBLIC_ROOM || 'public_chat_room',
  timeout: Number(process.env.TIMEOUT || 10000)
};

function ParseArgs(argv) {
  const opts = Object.assign({}, DEFAULTS, {
    diagnose: false, json: false, verbose: false, help: false, only: null
  });
  const alias = { u: 'url', k: 'key', r: 'room', t: 'timeout', v: 'verbose', h: 'help', d: 'diagnose' };

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (!arg.startsWith('-')) continue;
    let [name, inlineValue] = arg.replace(/^--?/, '').split('=');
    name = alias[name] || name;
    const takesValue = ['url', 'key', 'room', 'timeout', 'only'].includes(name);
    const value = inlineValue !== undefined ? inlineValue : (takesValue ? argv[++i] : true);

    if (name === 'timeout') opts.timeout = Number(value);
    else if (name in opts) opts[name] = value;
    else { console.error(`گزینه ناشناخته: ${arg}`); process.exit(2); }
  }
  return opts;
}

const HELP = `
تستر چت سرور هکم

  node cli.js --url http://<ip>:<port> [گزینه‌ها]

گزینه‌ها:
  -u, --url <آدرس>      آدرس سرور چت (یا متغیر CHAT_URL)            [الزامی]
  -k, --key <کلید>      کلید AES سرور، دقیقاً ۳۲ کاراکتر (یا AES_KEY)
  -r, --room <نام>      نام اتاق عمومی (یا PUBLIC_ROOM)   [پیش‌فرض public_chat_room]
  -t, --timeout <ms>    تایم‌اوت هر مرحله                  [پیش‌فرض 10000]
  -d, --diagnose        فقط عیب‌یابی شبکه — هیچ پکیجی لازم ندارد
      --only <کلیدها>   فقط این سناریوها، با کاما جدا شده
  -v, --verbose         لاگ کامل هر پیام رد و بدل شده
      --json            خروجی JSON برای اسکریپت‌نویسی
  -h, --help            همین راهنما

کلید سناریوها برای --only:
  ${SCENARIOS.map(s => s.key).join(', ')}

مثال‌ها:
  node cli.js -u http://1.2.3.4:3008 -k 'p2s5v8y/B?E(H+MbPeShVmYq3t6w9z$C'
  node cli.js -u http://1.2.3.4:3008 --diagnose
  node cli.js -u http://1.2.3.4:3008 --only public-broadcast,anti-flood -v
`;

// ===================== نمایش =====================
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s);
const bold = c('1'), dim = c('2'), green = c('32'), red = c('31'), yellow = c('33'), blue = c('36');

const MARK_OK = () => green('✔');
const MARK_BAD = () => red('✘');
const MARK_WARN = () => yellow('!');

function heading(text) {
  console.log('');
  console.log(bold(text));
  console.log(dim('─'.repeat(Math.max(text.length, 40))));
}

function indent(text, pad = '      ') {
  return String(text).split('\n').map(l => pad + l).join('\n');
}

function PrintDiagnostics(report) {
  heading('عیب‌یابی شبکه  →  ' + report.target);
  for (const s of report.steps) {
    const mark = s.ok === false ? MARK_BAD() : (s.reason && s.ok ? MARK_WARN() : MARK_OK());
    const ms = s.ms == null ? '' : dim(` ${s.ms.toFixed(0)}ms`);
    console.log(`  ${mark} ${bold(s.name.padEnd(11))} ${s.detail}${ms}`);
    if (s.reason) console.log(indent(dim('↳ ' + s.reason)));
  }
  if (report.fatal) {
    console.log('');
    console.log(red(`  عیب‌یابی در لایه «${report.fatal}» متوقف شد — تا این لایه درست نشود، بقیه بی‌معنی است.`));
  }
}

function PrintResults(results) {
  heading('تست‌های فانکشنال');
  for (const r of results) {
    const mark = r.ok ? MARK_OK() : MARK_BAD();
    const ms = dim(` ${r.ms.toFixed(0)}ms`);
    console.log(`  ${mark} ${r.title}${ms}`);
    if (r.ok) {
      if (r.detail) console.log(indent(dim(r.detail)));
    } else {
      console.log(indent(red(r.error)));
      if (r.hint) console.log(indent(dim('↳ ' + r.hint)));
    }
  }
}

/**
 * ترکیب نتایج معنی می‌دهد، نه فقط تک‌تکشان.
 * مثلاً «ذخیره شد ولی به کسی نرسید» یک امضای مشخص از خرابی لایه پخش است.
 */
function Analyze(results, diag) {
  const by = {};
  results.forEach(r => { by[r.key] = r; });
  const ok = (k) => by[k] && by[k].ok;
  const bad = (k) => by[k] && !by[k].ok;
  const notes = [];

  if (bad('public-broadcast') && ok('public-history')) {
    notes.push(
      'پیام در MySQL ذخیره شد ولی به هیچ کلاینتی نرسید.\n' +
      'یعنی سرور پیام را کامل پردازش کرد و فقط لایه پخش (socket.to(room).emit) کار نمی‌کند. سه علت محتمل:\n' +
      '  • ناسازگاری نسخه: socket.io v4 با پکیج socket.io-redis کار نمی‌کند (آنجا باید @socket.io/redis-adapter باشد).\n' +
      '    سرور این خطا را در try/catch می‌بلعد، سالم به‌نظر می‌رسد و پیام‌ها را ذخیره می‌کند ولی هیچ‌کس چیزی دریافت نمی‌کند.\n' +
      '    لاگ سرور را برای «Redis adapter failed to load» ببینید.\n' +
      '  • حالت cluster بدون SHOULD_USE_NGINX_REDIS=true — دو کلاینت روی دو worker جدا افتاده‌اند.\n' +
      '  • نام اتاق عمومی با PUBLIC_ROOM_NAME سرور فرق دارد.'
    );
  }

  if (ok('public-broadcast') && bad('public-history')) {
    notes.push(
      'پخش زنده کار می‌کند ولی پیام در تاریخچه نیست.\n' +
      'یعنی سوکت سالم است و مشکل فقط MySQL است: وجود جدول public_chat، نام ستون‌ها، یا دسترسی کاربر دیتابیس.'
    );
  }

  if (bad('anti-flood') && ok('public-broadcast')) {
    notes.push(
      'پیام‌ها می‌رسند ولی کول‌داون اعمال نمی‌شود.\n' +
      'ضدفلود عملاً غیرفعال است و هر کاربر می‌تواند بدون محدودیت اسپم کند. وضعیت Redis را چک کنید.'
    );
  }

  if (bad('malformed')) {
    notes.push(
      'سرور با یک payload بدشکل از پا درآمد.\n' +
      'یعنی هر کسی که بتواند به سوکت وصل شود می‌تواند کل چت سرور را بخواباند. این را فوری درست کنید.'
    );
  }

  if (diag && diag.steps) {
    const ws = diag.steps.find(s => s.name === 'WebSocket');
    if (ws && ws.ok === false) {
      notes.push(
        'ارتقا به WebSocket شکست خورد، پس ارتباط روی polling افتاده است.\n' +
        'کار می‌کند ولی کندتر و پرمصرف‌تر است. اگر nginx جلوی سرور دارید، تنظیمات proxy_set_header را چک کنید.'
      );
    }
  }

  return notes;
}

function PrintLog(entry) {
  const colors = { in: green, out: blue, err: red, sys: dim };
  const paint = colors[entry.kind] || dim;
  const time = entry.at.toISOString().slice(11, 23);
  let line = `  ${dim(time)} ${paint('[' + entry.client + ']')} ${entry.title}`;
  if (entry.body !== undefined) {
    const body = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body);
    line += ' ' + dim(body.length > 400 ? body.slice(0, 400) + '…' : body);
  }
  console.log(line);
}

// ===================== اجرا =====================
async function main() {
  const opts = ParseArgs(process.argv.slice(2));

  if (opts.help || !opts.url) {
    console.log(HELP);
    process.exit(opts.url ? 0 : 2);
  }

  if (!/^https?:\/\//.test(opts.url)) {
    console.error(red('آدرس باید با http:// یا https:// شروع شود — مثلاً http://1.2.3.4:3008'));
    process.exit(2);
  }

  const out = { target: opts.url, diagnostics: null, scenarios: [], ok: false };

  // ---------- لایه شبکه ----------
  const diag = await RunDiagnostics(opts.url, { timeout: opts.timeout });
  out.diagnostics = diag;
  if (!opts.json) PrintDiagnostics(diag);

  if (diag.fatal) {
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  if (opts.diagnose) {
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log('');
      console.log(green('  شبکه سالم است. برای تست فانکشنالیتی، --diagnose را بردارید.'));
    }
    process.exit(0);
  }

  // ---------- کلید AES ----------
  if (Buffer.from(opts.key, 'utf8').length !== 32) {
    console.error(red(`\nکلید AES باید دقیقاً ۳۲ بایت باشد (الان ${Buffer.from(opts.key, 'utf8').length} است).`));
    console.error(dim('مقدار AES_ENCRYPTION_SECRET_KEY سرور را با --key یا متغیر AES_KEY بدهید.'));
    process.exit(2);
  }

  // ---------- کلاینت‌ها ----------
  const logSink = opts.verbose && !opts.json ? PrintLog : () => {};
  const openClients = [];

  const makeClient = (id, details) => {
    const client = new NodeChatClient({
      id, url: opts.url, key: opts.key,
      serverMajor: diag.serverMajor, timeout: opts.timeout,
      onLog: logSink, details
    });
    openClients.push(client);
    return client;
  };

  const A = makeClient('A', {
    user_id: 'tester_a_' + Math.random().toString(36).slice(2, 8),
    user_name: 'tester_A', user_uniquename: 'uniq_a', user_avatar_id: 3, user_level: 12
  });
  const B = makeClient('B', {
    user_id: 'tester_b_' + Math.random().toString(36).slice(2, 8),
    user_name: 'tester_B', user_uniquename: 'uniq_b', user_avatar_id: 5, user_level: 7
  });

  let tempCount = 0;
  const makeTempClient = async () => {
    const t = makeClient('T' + (++tempCount), { user_id: 'temp_' + tempCount, user_name: 'temp' });
    await t.connect();
    return t;
  };

  if (opts.verbose && !opts.json) heading('لاگ زنده');

  try {
    await Promise.all([A.connect(), B.connect()]);
  } catch (err) {
    console.error(red('\n' + err.message));
    // خطای «پکیج نصب نیست» ربطی به شبکه ندارد؛ راهنمای اشتباه ندهیم
    if (!/npm install/.test(err.message)) {
      console.error(dim('لایه شبکه سالم بود ولی هندشیک socket.io کامل نشد. با --verbose جزئیات بیشتری می‌بینید.'));
    }
    openClients.forEach(cl => cl.close());
    process.exit(1);
  }

  out.transport = A.currentTransport();
  if (!opts.json) {
    const note = out.transport === 'websocket'
      ? 'ارتباط چت روی WebSocket برقرار شد (نه درخواست/پاسخ HTTP)'
      : `ارتباط چت روی «${out.transport}» برقرار شد — ارتقا به websocket انجام نشده و روی fallback مانده است`;
    console.log('');
    console.log('  ' + (out.transport === 'websocket' ? green('✔') : yellow('!')) + ' ' + bold('Transport'.padEnd(11)) + ' ' + note);
  }

  // ---------- پیش‌بررسی کلید AES ----------
  // اگر کلید غلط باشد سرور جواب می‌دهد ولی رمزگشایی نمی‌شود. بدون این بررسی،
  // هر ۹ سناریو یکی‌یکی تایم‌اوت می‌خورند و علت واقعی گم می‌شود.
  // هر دو کلاینت اینجا احراز هویت می‌شوند تا --only هم کار کند: سناریوهای بعدی
  // فرض می‌کنند B عضو اتاق عمومی است، کاری که در حالت عادی سناریوی اول انجام می‌دهد.
  const keyOk = await Promise.race([
    Promise.all([A.sendUserDetails(), B.sendUserDetails()]).then(() => true, () => false),
    A.onDecryptFailure().then(() => false),
    B.onDecryptFailure().then(() => false)
  ]);

  if (!keyOk && (A.decryptFailures > 0 || B.decryptFailures > 0)) {
    console.error(red('\n  کلید AES اشتباه است.'));
    console.error(dim('  سرور پاسخ داد ولی محتوایش با این کلید رمزگشایی نشد.'));
    console.error(dim('  مقدار AES_ENCRYPTION_SECRET_KEY را از config.js سرور بردارید و با --key بدهید.\n'));
    out.error = 'wrong-aes-key';
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    openClients.forEach(cl => cl.close());
    process.exit(1);
  }

  if (!keyOk) {
    console.error(red('\n  سرور به get_user_details پاسخی نداد.'));
    console.error(dim('  شبکه سالم بود، پس مشکل سمت اپلیکیشن است. با --verbose جزئیات بیشتری می‌بینید.\n'));
    out.error = 'no-response';
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    openClients.forEach(cl => cl.close());
    process.exit(1);
  }

  // ---------- سناریوها ----------
  const ctx = { A, B, makeTempClient, publicRoom: opts.room, state: {} };
  const wanted = opts.only ? String(opts.only).split(',').map(s => s.trim()) : null;
  const list = wanted ? SCENARIOS.filter(s => wanted.includes(s.key)) : SCENARIOS;

  if (wanted && !list.length) {
    console.error(red(`هیچ سناریویی با «${opts.only}» نخواند. کلیدهای معتبر: ${SCENARIOS.map(s => s.key).join(', ')}`));
    openClients.forEach(cl => cl.close());
    process.exit(2);
  }

  for (const scenario of list) {
    const t0 = Date.now();
    const row = { key: scenario.key, title: scenario.title, ok: false, ms: 0, detail: '', error: '', hint: scenario.hint || '' };
    try {
      row.detail = await scenario.run(ctx);
      row.ok = true;
    } catch (err) {
      row.error = err.message;
    }
    row.ms = Date.now() - t0;
    out.scenarios.push(row);
  }

  openClients.forEach(cl => cl.close());

  const failed = out.scenarios.filter(r => !r.ok);
  out.ok = failed.length === 0;
  out.analysis = Analyze(out.scenarios, diag);

  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    PrintResults(out.scenarios);
    if (out.analysis.length) {
      heading('تحلیل');
      out.analysis.forEach(note => {
        console.log(indent(yellow(note), '  '));
        console.log('');
      });
    }
    console.log('');
    console.log(out.ok
      ? green(bold(`  همه ${out.scenarios.length} تست پاس شد — سرور چت درست کار می‌کند.`))
      : red(bold(`  ${failed.length} از ${out.scenarios.length} تست شکست خورد.`)));
    console.log('');
  }

  process.exit(out.ok ? 0 : 1);
}

// تور ایمنی: یک promise رد شده و بدون صاحب نباید کل گزارش را از بین ببرد
process.on('unhandledRejection', (err) => {
  console.error(red('\nPromise رد شده و مدیریت‌نشده: ' + (err && err.message ? err.message : err)));
  process.exit(1);
});

main().catch(err => {
  console.error(red('\nخطای غیرمنتظره: ' + (err && err.stack ? err.stack : err)));
  process.exit(1);
});
