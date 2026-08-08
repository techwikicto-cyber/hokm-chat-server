const socket = require("socket.io");
const http = require('http');
const crypto = require('crypto');
const mysql = require('mysql2');
const redis = require('redis');
const { promisify } = require('util');

const config = require('../config');

const AES_KEY = Buffer.from(config.AES_ENCRYPTION_SECRET_KEY);
const IV_LENGTH = 16;

// ===================== MySQL Connection =====================
const mysqlConnection = mysql.createConnection({
  host: config.MYSQL_HOST,
  user: config.MYSQL_USER,
  password: config.MYSQL_PASSWORD,
  database: config.MYSQL_DATABASE_NAME
});
mysqlConnection.connect();

// ===================== Redis Connection (For Anti-Flood) =====================
const redisClient = redis.createClient({
  host: config.REDIS_IP,
  port: config.REDIS_PORT
});

const getRedisAsync = promisify(redisClient.get).bind(redisClient);
const setexRedisAsync = promisify(redisClient.setex).bind(redisClient);

// ===================== Helpers =====================
function FormatUsernameForDisplay(username) {
  return username && username.length > 8
    ? username.substring(0, 8) + '...'
    : (username || '');
}

function FormatTimestamp(dbTime) {
  if (!dbTime) return Date.now();
  if (dbTime instanceof Date) return dbTime.getTime();

  const num = Number(dbTime);
  if (!isNaN(num) && num > 0) {
    return num;
  }

  const parsed = new Date(dbTime).getTime();
  return isNaN(parsed) ? Date.now() : parsed;
}

function SavePublicChatToMySQL(message, messageTime, userId, userName, userUniquename, userAvatarId, userLevel) {
  const query = 'INSERT INTO public_chat (user_id, user_name, message, message_time, user_uniquename, user_avatar_id, user_level) VALUES (?, ?, ?, ?, ?, ?, ?)';
  const params = [userId, userName, message, messageTime, userUniquename || null, userAvatarId || 0, userLevel || 0];
  mysqlConnection.query(query, params, (err) => {
    if (err) console.error('[MySQL] SavePublicChat ERROR:', err.message);
  });
}

function SavePrivateChatToMySQL(roomName, message, messageTime, userId, userName, userAvatarId, userLevel, userUniquename) {
  if (!roomName || (!isNaN(roomName) && parseInt(roomName) < 10000000)) return;
  const query = 'INSERT INTO private_chat (room_name, user_id, user_name, message, message_time, user_avatar_id, user_level, user_uniquename) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  mysqlConnection.query(query, [roomName, userId, userName, message, messageTime, userAvatarId, userLevel, userUniquename || null]);
}

function GetPublicChatsFromMySQL(callback) {
  const query = 'SELECT * FROM public_chat ORDER BY id DESC LIMIT ?';
  mysqlConnection.query(query, [config.MAXIMUM_PUBLIC_ROOM_CHATS_LENGTH], (error, results) => {
    if (error) return callback([]);

    // مرتب‌سازی برعکس برای نمایش درست در کلاینت چت
    const formattedChats = results.reverse().map(chat => ({
      sender_details: {
        user_id: chat.user_uniquename || chat.user_id,
        user_name: FormatUsernameForDisplay(chat.user_name),
        user_avatar_id: chat.user_avatar_id || 0 ,
        user_uniquename: chat.user_uniquename || "",
        user_level: chat.user_level || 0
      },
      message: chat.message,
      message_time: FormatTimestamp(chat.message_time), // اصلاح زمان چت‌های قدیمی عمومی
      is_emoji_active: config.IS_EMOJI_ACTIVE
    }));
    callback(formattedChats);
  });
}

function GetPrivateChatsFromMySQL(roomName, callback) {
  const query = 'SELECT * FROM private_chat WHERE room_name = ? ORDER BY id DESC LIMIT ?';
  mysqlConnection.query(query, [roomName, config.MAXIMUM_PRIVATE_ROOM_CHATS_LENGTH], (error, results) => {
    if (error) return callback([]);
    const formattedChats = results.reverse().map(chat => ({
      sender_details: {
        user_id: chat.user_uniquename || chat.user_id,
        user_name: FormatUsernameForDisplay(chat.user_name),
        user_avatar_id: chat.user_avatar_id || 0,
        user_uniquename: chat.user_uniquename || "",
        user_level: chat.user_level || 0
      },
      message: chat.message,
      message_time: FormatTimestamp(chat.message_time), // اصلاح زمان چت‌های قدیمی خصوصی
      is_emoji_active: config.IS_EMOJI_ACTIVE,
      meta: { revision: 0, created: FormatTimestamp(chat.message_time), version: 0 },
      $loki: chat.id
    }));
    callback(formattedChats);
  });
}

function RemoveSpecialCharacters(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/[~!@#$%^&*()_|+\-=?;:'",.<>{}\[\]\\\/]|<[^>]+>/gi, '');
}

function RemovePhoneNumber(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/((9|09)[0-9]{9})/g, "");
}

// ===================== Encryption Helpers =====================
function EncryptData(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, iv);
  let encrypted = cipher.update(text, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function DecryptData(text) {
  try {
    const [ivHex, dataHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encryptedText = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) {
    return null;
  }
}

// در اختیار گذاشتن همین توابع برای صفحه تست، تا دقیقاً همان منطق رمزنگاری کلاینت واقعی تست شود
exports.EncryptData = EncryptData;
exports.DecryptData = DecryptData;

// ===================== UGC FILTER =====================
async function isMessageClean(chatMessage) {
  if (!chatMessage || chatMessage.trim() === '') return true;

  try {
    const apiCall = new Promise((resolve) => {
      const postData = JSON.stringify({ text: chatMessage });

      const options = {
        hostname: '127.0.0.1',
        port: 5012,
        path: '/ugc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result.bad_content !== 1);
          } catch {
            resolve(true);
          }
        });
      });

      req.on('error', () => resolve(true));
      req.write(postData);
      req.end();
    });

    const timeout = new Promise(resolve => setTimeout(() => resolve(true), 2500));
    return await Promise.race([apiCall, timeout]);

  } catch {
    return true;
  }
}

// ===================== Messaging Logic =====================
async function sendChatMessageAsync(cSocket, userDetails, roomName, chatMessage) {
  const userId = userDetails.user_id;
  const now = Date.now();
  const coolDownSeconds = 8;

  // Anti-Flood کنترل هوشمند اسپم با ردیس روی کلستر
  const redisKey = `chat_cooldown:${userId}`;
  const isBlocked = await getRedisAsync(redisKey);

  if (isBlocked) {
    const response = { type: "error", message: `Please wait before sending another message.` };
    cSocket.emit('get_data', { data: EncryptData(JSON.stringify(response)) });
    return;
  }

  const cleanMsg = RemovePhoneNumber(RemoveSpecialCharacters(chatMessage));

  // UGC Filter
  if (!(await isMessageClean(cleanMsg))) {
    return;
  }

  // ثبت کول‌داون در ردیس
  await setexRedisAsync(redisKey, coolDownSeconds, '1');

  if (roomName === config.PUBLIC_ROOM_NAME) {
    const chatObj = {
      sender_details: {
        user_id: userDetails.user_id,
        user_name: FormatUsernameForDisplay(userDetails.user_name),
        user_avatar_id: userDetails.user_avatar_id || 0,
        user_uniquename: userDetails.user_uniquename || "",
        user_level: userDetails.user_level || 0
      },
      message: cleanMsg,
      message_time: now, // ارسال لایو تفاوتی ندارد چون عدد خام است
      is_emoji_active: config.IS_EMOJI_ACTIVE
    };

    SavePublicChatToMySQL(chatObj.message, chatObj.message_time, userDetails.user_id, userDetails.user_name, userDetails.user_uniquename, userDetails.user_avatar_id, userDetails.user_level);

    const response = { type: "get_other_user_chat", chat_message_object: chatObj, room_name: roomName };
    cSocket.to(roomName).emit('get_data', { data: EncryptData(JSON.stringify(response)) });

  } else {
    const chatObj = {
      sender_details: {
        user_id: userDetails.user_uniquename || userDetails.user_id,
        user_name: FormatUsernameForDisplay(userDetails.user_name),
        user_avatar_id: userDetails.user_avatar_id || 0,
        user_uniquename: userDetails.user_uniquename || "",
        user_level: userDetails.user_level || 0
      },
      message: cleanMsg,
      message_time: now,
      is_emoji_active: config.IS_EMOJI_ACTIVE,
      meta: { revision: 0, created: now, version: 0 }
    };

    SavePrivateChatToMySQL(roomName, chatObj.message, chatObj.message_time, userDetails.user_id, userDetails.user_name, userDetails.user_avatar_id, userDetails.user_level, userDetails.user_uniquename);

    const response = { type: "get_other_user_chat", chat_message_object: chatObj, room_name: roomName };
    cSocket.to(roomName).emit('get_data', { data: EncryptData(JSON.stringify(response)) });
  }
}

function SendChatMessage(cSocket, userDetails, roomName, chatMessage) {
  sendChatMessageAsync(cSocket, userDetails, roomName, chatMessage)
    .catch(err => console.error(err));
}

// ===================== MAIN INITIALIZATION =====================
exports.InitializeClientsSocketIO = function (server) {
  const io = socket(server);

  // ===================== Redis Adapter =====================
  if (config.SHOULD_USE_NGINX_REDIS) {
    try {
      const serviceName = process.env.SERVICE_NAME || 'hokm';
      const redisKey = `socket.io:${serviceName}`;

      const redisAdapter = require('socket.io-redis');
      io.adapter(redisAdapter({
        host: config.REDIS_IP,
        port: config.REDIS_PORT,
        key: redisKey
      }));

      console.log(`[SOCKET.IO] Redis adapter ENABLED → ${config.REDIS_IP}:${config.REDIS_PORT} | Service: ${serviceName} | Key: ${redisKey}`);
    } catch (err) {
      console.error('[SOCKET.IO] Redis adapter failed to load:', err.message);
    }
  }

  io.on("connection", function (clientSocket) {
    let thisUserDetails = null;
    let currentPrivateChatRoomName = '';

    clientSocket.on('disconnect', function () {
      thisUserDetails = null;
      currentPrivateChatRoomName = '';
    });

    clientSocket.on('get_user_details', function (request) {
      try {
        thisUserDetails = JSON.parse(DecryptData(request));
      } catch (e) { thisUserDetails = null; }

      if (!thisUserDetails) {
        clientSocket.emit('get_data', {
          data: EncryptData(JSON.stringify({
            type: "get_privious_public_chats",
            public_chats: [],
            is_emoji_active: config.IS_EMOJI_ACTIVE
          }))
        });
        return;
      }

      clientSocket.join(config.PUBLIC_ROOM_NAME);

      GetPublicChatsFromMySQL((publicChatMessages) => {
        clientSocket.emit('get_data', {
          data: EncryptData(JSON.stringify({
            type: "get_privious_public_chats",
            public_chats: publicChatMessages,
            is_emoji_active: config.IS_EMOJI_ACTIVE
          }))
        });
      });
    });

    clientSocket.on('join_chat_room', function (request) {
      let newRoomName = "";
      try { newRoomName = JSON.parse(DecryptData(request)).room_name; } catch (err) { return; }

      if (currentPrivateChatRoomName && currentPrivateChatRoomName !== newRoomName) {
        clientSocket.leave(currentPrivateChatRoomName);
      }

      clientSocket.join(newRoomName);
      currentPrivateChatRoomName = newRoomName;

      GetPrivateChatsFromMySQL(newRoomName, (privateChats) => {
        clientSocket.emit('get_data', {
          data: EncryptData(JSON.stringify({
            type: "get_privious_private_chats",
            private_chats: privateChats
          }))
        });
      });
    });

    clientSocket.on('send_chat_message', function (request) {
      let data = null;
      try { data = JSON.parse(DecryptData(request)); } catch (e) { return; }

      if (!thisUserDetails) {
        clientSocket.emit('get_data', {
          data: EncryptData(JSON.stringify({ type: "request_user_details" }))
        });
        return;
      }

      SendChatMessage(clientSocket, thisUserDetails, data.room_name, data.message || "");
    });
  });
};