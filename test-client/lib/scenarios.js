/**
 * سناریوهای تست فانکشنالیتی — مشترک بین CLI و صفحه مرورگر.
 *
 * این فایل هم در Node و هم در مرورگر لود می‌شود، پس فقط JS خالص است و
 * به هیچ API خاص محیطی وابسته نیست. هر سناریو با یک ctx کار می‌کند:
 *
 *   ctx.A, ctx.B        دو کلاینت با این متدها:
 *                       connect, sendUserDetails, joinRoom, sendMessage,
 *                       waitFor(predicate, label, timeout), rotateUserId
 *   ctx.makeTempClient  ساخت کلاینت موقت بدون UI (برای تست‌های اتصال تازه)
 *   ctx.publicRoom      نام اتاق عمومی
 *   ctx.state           فضای اشتراکی بین سناریوها
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HokmScenarios = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COOLDOWN_SECONDS = 8;

  function randFrom(chars, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  const rand = (n) => randFrom('abcdefghijklmnopqrstuvwxyz0123456789', n || 6);
  // فقط حروف — تا توکن تصادفی خودش الگوی شماره موبایل نسازد و تست فیلتر را خراب نکند
  const randAlpha = (n) => randFrom('abcdefghijklmnopqrstuvwxyz', n || 4);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function isMsg(token, room) {
    return function (p) {
      return p && p.type === 'get_other_user_chat' &&
        (!room || p.room_name === room) &&
        p.chat_message_object && String(p.chat_message_object.message).indexOf(token) !== -1;
    };
  }

  function summarize(p) {
    if (!p || !p.type) return String(p);
    switch (p.type) {
      case 'get_privious_public_chats':  return 'تاریخچه عمومی (' + (p.public_chats || []).length + ' پیام)';
      case 'get_privious_private_chats': return 'تاریخچه خصوصی (' + (p.private_chats || []).length + ' پیام)';
      case 'get_other_user_chat':        return 'پیام جدید در «' + p.room_name + '»: ' + (p.chat_message_object && p.chat_message_object.message);
      case 'request_user_details':       return 'سرور درخواست user_details کرد';
      case 'error':                      return 'خطا: ' + p.message;
      default:                           return p.type;
    }
  }

  // یک waiter که قبل از await بعدی ساخته می‌شود، اگر آن await خطا بدهد بی‌صاحب می‌ماند
  // و در Node به unhandledRejection و کرش پروسه تبدیل می‌شود. این پوشش جلویش را می‌گیرد
  // بدون این‌که رد شدن واقعی را از دست بدهیم.
  function pending(promise) {
    promise.catch(function () {});
    return promise;
  }

  // سرور روی هر user_id کول‌داون ۸ ثانیه‌ای می‌گذارد. به‌جای صبر کردن،
  // قبل از هر ارسال شناسه A را عوض و دوباره احراز هویت می‌کنیم.
  async function freshAuthA(ctx) {
    ctx.A.rotateUserId();
    await ctx.A.sendUserDetails();
  }

  const SCENARIOS = [
    {
      key: 'connect',
      title: 'اتصال هر دو کلاینت + get_user_details',
      hint: 'اگر تایم‌اوت شد، کلید AES اشتباه است (سرور جواب می‌دهد ولی رمزگشایی نمی‌شود) یا سرور اصلاً پاسخ نمی‌دهد.',
      async run(ctx) {
        const results = await Promise.all([ctx.A.sendUserDetails(), ctx.B.sendUserDetails()]);
        return 'A: ' + results[0].public_chats.length + ' پیام تاریخچه، ' +
               'B: ' + results[1].public_chats.length + ' پیام — is_emoji_active=' + results[0].is_emoji_active;
      }
    },
    {
      key: 'public-broadcast',
      title: 'چت عمومی: A می‌فرستد، B دریافت می‌کند',
      hint: 'شایع‌ترین علت‌ها:\n' +
            '  ۱) Redis روی سرور بالا نیست — سرور قبل از هر ارسال برای ضدفلود به Redis می‌زند و خطا را بی‌صدا می‌بلعد.\n' +
            '  ۲) سرور در حالت cluster بدون SHOULD_USE_NGINX_REDIS اجرا شده و دو کلاینت روی دو worker افتاده‌اند.\n' +
            '  ۳) نام اتاق عمومی با PUBLIC_ROOM_NAME سرور فرق دارد.',
      async run(ctx) {
        await freshAuthA(ctx);
        const token = 'pub' + rand(6);
        ctx.state.publicToken = token;
        const wait = pending(ctx.B.waitFor(isMsg(token, ctx.publicRoom), 'پیام عمومی روی B'));
        await ctx.A.sendMessage(ctx.publicRoom, 'testpublic ' + token);
        const s = (await wait).chat_message_object.sender_details;
        return 'دریافت شد — sender=' + s.user_name + '/' + s.user_id +
               ' level=' + s.user_level + ' avatar=' + s.user_avatar_id;
      }
    },
    {
      key: 'public-history',
      title: 'ذخیره در MySQL: پیام عمومی در تاریخچه می‌آید',
      hint: 'یعنی INSERT یا SELECT روی جدول public_chat مشکل دارد — وجود جدول، نام ستون‌ها و دسترسی کاربر MySQL را چک کنید.',
      async run(ctx) {
        if (!ctx.state.publicToken) throw new Error('تست چت عمومی اجرا نشده است');
        await sleep(400);
        const res = await ctx.B.sendUserDetails();
        const chats = res.public_chats || [];
        const found = chats.some(c => String(c.message).indexOf(ctx.state.publicToken) !== -1);
        if (!found) throw new Error('در ' + chats.length + ' پیام آخر جدول public_chat پیدا نشد');
        const last = chats[chats.length - 1];
        return 'پیدا شد — message_time آخرین پیام: ' + last.message_time +
               ' (' + new Date(last.message_time).toISOString() + ')';
      }
    },
    {
      key: 'private-broadcast',
      title: 'اتاق خصوصی: join_chat_room و پخش پیام',
      hint: 'اگر join جواب داد ولی پیام نرسید، مشکل همان broadcast است (Redis / cluster).',
      async run(ctx) {
        const room = String(20000000 + Math.floor(Math.random() * 9000000));
        ctx.state.privateRoom = room;
        await ctx.B.joinRoom(room);
        await ctx.A.joinRoom(room);
        await freshAuthA(ctx);
        const token = 'prv' + rand(6);
        ctx.state.privateToken = token;
        const wait = pending(ctx.B.waitFor(isMsg(token, room), 'پیام خصوصی روی B'));
        await ctx.A.sendMessage(room, 'testprivate ' + token);
        await wait;
        return 'اتاق ' + room + ' — پیام خصوصی به کلاینت دوم رسید';
      }
    },
    {
      key: 'private-history',
      title: 'تاریخچه اتاق خصوصی از MySQL',
      hint: 'توجه: اگر نام اتاق عددی و کوچک‌تر از 10000000 باشد، سرور عمداً ذخیره‌اش نمی‌کند (پخش زنده انجام می‌شود ولی تاریخچه نه).',
      async run(ctx) {
        if (!ctx.state.privateRoom) throw new Error('تست اتاق خصوصی اجرا نشده است');
        await sleep(400);
        const res = await ctx.B.joinRoom(ctx.state.privateRoom);
        const chats = res.private_chats || [];
        if (!chats.some(c => String(c.message).indexOf(ctx.state.privateToken) !== -1)) {
          throw new Error('در ' + chats.length + ' پیام تاریخچه اتاق پیدا نشد');
        }
        return chats.length + ' پیام در تاریخچه اتاق ' + ctx.state.privateRoom;
      }
    },
    {
      key: 'anti-flood',
      title: 'ضدفلود: پیام دوم باید با خطای کول‌داون رد شود',
      hint: 'اگر خطا نیامد یعنی Redis کول‌داون را ثبت نمی‌کند (SETEX/GET) و ضدفلود عملاً غیرفعال است.',
      async run(ctx) {
        await freshAuthA(ctx);
        const t1 = 'flooda' + rand(4), t2 = 'floodb' + rand(4);
        const first = pending(ctx.B.waitFor(isMsg(t1), 'پیام اول روی B'));
        const errWait = pending(ctx.A.waitFor(p => p && p.type === 'error', 'خطای کول‌داون روی A'));
        await ctx.A.sendMessage(ctx.publicRoom, t1);
        await first;
        await ctx.A.sendMessage(ctx.publicRoom, t2);
        return 'پیام دوم رد شد → "' + (await errWait).message + '" (کول‌داون ' + COOLDOWN_SECONDS + ' ثانیه)';
      }
    },
    {
      key: 'filters',
      title: 'فیلتر: حذف شماره موبایل و کاراکترهای خاص',
      hint: 'سرور باید هم کاراکترهای خاص و هم الگوی شماره موبایل ایران را از متن پیام حذف کند.',
      async run(ctx) {
        await freshAuthA(ctx);
        const a = 'aa' + randAlpha(4), b = 'bb' + randAlpha(4);
        const raw = a + '09121234567' + b + '!@#$%';
        const expected = a + b;
        const wait = pending(ctx.B.waitFor(
          p => p && p.type === 'get_other_user_chat' && p.chat_message_object &&
               String(p.chat_message_object.message).indexOf(a) !== -1,
          'پیام فیلترشده روی B'));
        await ctx.A.sendMessage(ctx.publicRoom, raw);
        const received = (await wait).chat_message_object.message;
        if (received !== expected) throw new Error('انتظار «' + expected + '» بود ولی «' + received + '» رسید');
        return '«' + raw + '» → «' + received + '»';
      }
    },
    {
      key: 'unauthenticated',
      title: 'ارسال بدون احراز هویت → request_user_details',
      hint: 'سرور باید کاربری که هنوز user_details نفرستاده را رد کند و درخواست احراز هویت بدهد.',
      async run(ctx) {
        const temp = await ctx.makeTempClient();
        try {
          const wait = pending(temp.waitFor(p => p && p.type === 'request_user_details', 'request_user_details'));
          await temp.sendRaw('send_chat_message', { room_name: ctx.publicRoom, message: 'no auth ' + rand(4) });
          await wait;
          return 'سرور همان‌طور که انتظار می‌رفت user_details درخواست کرد';
        } finally { temp.close(); }
      }
    },
    {
      key: 'malformed',
      title: 'ورودی خراب (payload رمزنشده) نباید سرور را بیندازد',
      hint: 'اگر این تست قرمز شد یعنی یک کلاینت مخرب می‌تواند با یک پیام بدشکل کل سرور چت را بخواباند.',
      async run(ctx) {
        const temp = await ctx.makeTempClient();
        try {
          temp.emitRaw('get_user_details', 'not-encrypted-at-all');
          temp.emitRaw('join_chat_room', 'garbage:data');
          temp.emitRaw('send_chat_message', '###');
          await sleep(1500);
          if (!temp.isConnected()) throw new Error('سوکت پس از ورودی خراب قطع شد');

          // اثبات نهایی: یک اتصال کاملاً تازه هنوز جواب می‌گیرد
          const probe = await ctx.makeTempClient();
          try {
            const wait = pending(probe.waitFor(p => p && p.type === 'request_user_details', 'پاسخ سرور بعد از ورودی خراب'));
            await probe.sendRaw('send_chat_message', { room_name: ctx.publicRoom, message: 'probe' });
            await wait;
          } finally { probe.close(); }

          return 'سرور سالم ماند و به اتصال جدید پاسخ داد';
        } finally { temp.close(); }
      }
    }
  ];

  return { SCENARIOS, rand, randAlpha, sleep, isMsg, summarize, COOLDOWN_SECONDS };
}));
