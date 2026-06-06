const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const loki = require("lokijs");
const path = require("path");

const socketController = require("./controllers/socket-controller");

const app = express();

// ===================== ENV SAFE =====================
const PORT = Number(process.env.LISTEN_PORT || 3008);

// ===================== Middleware =====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// فقط در production cors
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

// ===================== GLOBAL GUARD (per worker only) =====================
if (global.__APP_STARTED__) {
  console.log(`[Worker ${process.pid}] already initialized`);
  module.exports = app;
  return;
}

global.__APP_STARTED__ = true;

// ===================== DB + SERVER =====================
const db = new loki(path.join(__dirname, "chat.hokm.db"), {
  autoload: true,

  autoloadCallback: () => {
    console.log(`[Worker ${process.pid}] LokiDB loaded`);

    // 🔥 IMPORTANT: always use PORT constant (NOT config)
    const server = app.listen(PORT, () => {
      console.log(`[Worker ${process.pid}] Server running on port ${PORT}`);

      socketController.InitializeClientsSocketIO(server, db);
    });
  },

  autosave: true,
  autosaveInterval: 4000,
  env: "NODEJS",
  serializationMethod: "pretty",
});

module.exports = app;
