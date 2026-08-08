const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");

const socketController = require("./controllers/socket-controller");

const app = express();

// ===================== ENV SAFE =====================
const PORT = Number(process.env.LISTEN_PORT || 3006);

// ===================== Middleware =====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ﻒﻋﺎﻟ<200c>ﺳﺍﺰﯾ CORS ﻒﻘﻃ ﺩﺭ ﻢﺤﯿﻃ Production ﯼﺍ ﻂﺒﻗ ﺖﻨﻈﯿﻣﺎﺗ ﺲﯿﺴﺘﻣ
if (process.env.IS_LOCAL !== "true") {
  app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
}

// ===================== Health check =====================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    pid: process.pid,
    port: PORT
  });
});

// ===================== Test page (opt-in) =====================
// فقط با ENABLE_TEST_PAGE=true فعال می‌شود؛ روی پروداکشن با TEST_PAGE_TOKEN محافظتش کنید.
if (process.env.ENABLE_TEST_PAGE === "true") {
  require("./controllers/test-page-controller").Register(app);
}

// ===================== GLOBAL GUARD (per worker only) =====================
if (global.__APP_STARTED__) {
  console.log(`[Worker ${process.pid}] already initialized`);
  module.exports = app;
  return;
}

global.__APP_STARTED__ = true;

// ===================== SERVER START =====================
// ﺱﺭﻭﺭ ﻢﺴﺘﻘﯿﻣﺍً ﻭ ﺏﺩﻮﻧ ﻢﻌﻄﻠﯾ ﺏﺭﺎﯾ ﺪﯿﺗﺎﺒﯿﺳ ﻢﺤﻠﯾ LokiJS ﺎﺴﺗﺍﺮﺗ ﻢﯾ<200c>ﺷﻭﺩ
const server = app.listen(PORT, () => {
  console.log(`[Worker ${process.pid}] Server running on port ${PORT}`);

  // ﻢﻗﺩﺍﺭﺪﻬﯾ ﺍﻮﻠﯿﻫ ﺐﻫ ﮎﻼﯿﻨﺗ<200c>ﻫﺍ ﻭ ﭖﺭﻮﺘﮑﻟ<200c>ﻫﺎﯾ ﺱﻮﮑﺗ
  socketController.InitializeClientsSocketIO(server);
});

module.exports = app;
