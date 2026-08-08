FROM node:20-alpine

WORKDIR /app

# اول فقط مانیفست‌ها تا لایه نصب پکیج‌ها کش شود.
# با lock فایل، build تکرارپذیر است و همان نسخه‌هایی نصب می‌شود که تست شده.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY cli.js server.js index.html ./
COPY lib ./lib

# صفحه مرورگری روی این پورت بالا می‌آید (فقط در حالت ui)
EXPOSE 8080

# حالت CLI. تنظیمات از tester.env می‌آید؛ آرگومان‌های اضافه بعد از نام سرویس
# مستقیم به cli.js پاس می‌شوند. اگر آدرس سرور نباشد، خود cli.js راهنما را چاپ می‌کند،
# پس اینجا CMD نمی‌گذاریم — وگرنه همیشه --help اجرا می‌شد.
ENTRYPOINT ["node", "cli.js"]
