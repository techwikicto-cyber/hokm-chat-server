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

# پیش‌فرض: حالت CLI. آدرس سرور را با --url یا متغیر CHAT_URL بدهید.
ENTRYPOINT ["node", "cli.js"]
CMD ["--help"]
