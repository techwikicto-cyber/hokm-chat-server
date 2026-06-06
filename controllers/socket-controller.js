const socket = require("socket.io");
const http = require('http');
const crypto = require('crypto');
const loki = require("lokijs");
const mysql = require('mysql2');
const path = require('path');

const config = require('../config');
const Queue = require('../classes/queue');
const PrivateChatRoomObject = require('../objects/private-chat-room-object');

const AES_KEY = Buffer.from(config.AES_ENCRYPTION_SECRET_KEY);
const IV_LENGTH = 16;

// Database & State
const dbPath = path.join(__dirname, '..', 'chat.hokm.db');
const db = new loki(dbPath, {
  autoload: true,
  autoloadCallback: () => {},
  autosave: true,
  autosaveInterval: 4000
});

let publicChatMessagesCollection;
let privateChatRooms = [];
const userMessageTimestamps = {}; // anti-flood

// MySQL connection
const mysqlConnection = mysql.createConnection({
  host: config.MYSQL_HOST,
  user: config.MYSQL_USER,
  password: config.MYSQL_PASSWORD,
  database: config.MYSQL_DATABASE_NAME
});
mysqlConnection.connect();

function FormatUsernameForDisplay(username) {
  return username && username.length > 8
    ? username.substring(0, 8) + '...'
    : (username || '');
}

function SavePublicChatToMySQL(message, messageTime, userId, userName, userUniquename) {
  const query = 'INSERT INTO public_chat (user_id, user_name, message, message_time, user_uniquename) VALUES (?, ?, ?, ?, ?)';
  mysqlConnection.query(query, [userId, userName, message, messageTime, userUniquename || null]);
}

function SavePrivateChatToMySQL(roomName, message, messageTime, userId, userName, userAvatarId, userLevel, userUniquename) {
  if (!roomName || (!isNaN(roomName) && parseInt(roomName) < 10000000)) return;
  const query = 'INSERT INTO private_chat (room_name, user_id, user_name, message, message_time, user_avatar_id, user_level, user_uniquename) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  mysqlConnection.query(query, [roomName, userId, userName, message, messageTime, userAvatarId, userLevel, userUniquename || null]);
}

function GetPrivateChatsFromMySQL(roomName, callback) {
  const query = 'SELECT * FROM private_chat WHERE room_name = ? ORDER BY id DESC LIMIT 20';
  mysqlConnection.query(query, [roomName], (error, results) => {
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
      message_time: chat.message_time,
      is_emoji_active: config.IS_EMOJI_ACTIVE,
      meta: { revision: 0, created: chat.message_time, version: 0 },
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

// Encryption helpers
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

function GetFirstDBCollectionItem() {
  const data = publicChatMessagesCollection.find();
  return data && data[0];
}

function GetPrivateChatRoomIndex(roomName) {
  return privateChatRooms.findIndex(i => i.roomName === roomName);
}

// ===================== UGC FILTER (بدون هیچ ریسپانسی) =====================
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
// =====================================================

async function sendChatMessageAsync(cSocket, userDetails, roomName, chatMessage) {
  const userId = userDetails.user_id;
  const now = Date.now();
  const coolDownMs = 8000;

  if (now - (userMessageTimestamps[userId] || 0) < coolDownMs) {
    const waitSec = ((coolDownMs - (now - userMessageTimestamps[userId])) / 1000).toFixed(1);
    const response = { type: "error", message: `Please wait ${waitSec} seconds before sending.` };
    cSocket.emit('get_data', { data: EncryptData(JSON.stringify(response)) });
    return;
  }

  const cleanMsg = RemovePhoneNumber(RemoveSpecialCharacters(chatMessage));

  // فیلتر UGC — بدون هیچ پاسخی به کاربر
  if (!(await isMessageClean(cleanMsg))) {
    return; // پیام بلاک شد و هیچ ریسپانسی ارسال نمی‌شود
  }

  userMessageTimestamps[userId] = now;

  if (roomName === config.PUBLIC_ROOM_NAME) {
    try {
      if (publicChatMessagesCollection.count() >= config.MAXIMUM_PUBLIC_ROOM_CHATS_LENGTH)
        publicChatMessagesCollection.remove(GetFirstDBCollectionItem());
    } catch (e) {}

    const chatObj = {
      sender_details: {
        user_id: userDetails.user_id,
        user_name: FormatUsernameForDisplay(userDetails.user_name),
        user_avatar_id: userDetails.user_avatar_id || 0,
        user_uniquename: userDetails.user_uniquename || "",
        user_level: userDetails.user_level || 0
      },
      message: cleanMsg,
      message_time: now,
      is_emoji_active: config.IS_EMOJI_ACTIVE
    };

    publicChatMessagesCollection.insert(chatObj);
    SavePublicChatToMySQL(chatObj.message, chatObj.message_time, userDetails.user_id, userDetails.user_name, userDetails.user_uniquename);

    const response = { type: "get_other_user_chat", chat_message_object: chatObj, room_name: roomName };
    cSocket.to(roomName).emit('get_data', { data: EncryptData(JSON.stringify(response)) });

  } else {
    let chatRoomIndex = GetPrivateChatRoomIndex(roomName);
    if (chatRoomIndex === -1) {
      const privateChatRoom = Object.create(PrivateChatRoomObject);
      privateChatRoom.roomName = roomName;
      privateChatRoom.chatRoomMembersCount = 1;
      privateChatRoom.chatsQueue = new Queue();
      privateChatRooms.push(privateChatRoom);
      chatRoomIndex = privateChatRooms.length - 1;
    }

    const chatRoom = privateChatRooms[chatRoomIndex];

    if (chatRoom.chatsQueue.length >= config.MAXIMUM_PRIVATE_ROOM_CHATS_LENGTH) {
      chatRoom.chatsQueue.dequeue();
    }

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
      meta: { revision: 0, created: now, version: 0 },
      $loki: chatRoom.chatsQueue.length + 1
    };

    chatRoom.chatsQueue.enqueue(chatObj);
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
exports.InitializeClientsSocketIO = function (server, mainDb) {
  if (!mainDb) return;
  publicChatMessagesCollection = mainDb.getCollection("public_chat_messages") || mainDb.addCollection("public_chat_messages");

  const io = socket(server);

  // ===================== Redis Adapter با Key جداگانه =====================
  if (config.SHOULD_USE_NGINX_REDIS) {
    try {
      const serviceName = process.env.SERVICE_NAME || 'hokm';   // ← از محیط می‌خواند
      const redisKey = `socket.io:${serviceName}`;

      const redisAdapter = require('socket.io-redis');
      io.adapter(redisAdapter({
        host: config.REDIS_IP,
        port: config.REDIS_PORT,
        key: redisKey                    // ← کلیدی متفاوت برای هر سرویس
      }));

      console.log(`[SOCKET.IO] Redis adapter ENABLED → ${config.REDIS_IP}:${config.REDIS_PORT} | Service: ${serviceName} | Key: ${redisKey}`);
    } catch (err) {
      console.error('[SOCKET.IO] Redis adapter failed to load:', err.message);
    }
  } else {
    console.log('[SOCKET.IO] Redis adapter disabled (SHOULD_USE_NGINX_REDIS = false)');
  }
  // =================================================================

  io.on("connection", function (clientSocket) {
    let thisUserDetails = null;
    let currentPrivateChatRoomName = '';
    let isJoinedToPublicRoom = false;
    let isJoinedToPrivateRoom = false;

    clientSocket.on('disconnect', function () {
      if (thisUserDetails && currentPrivateChatRoomName) {
        const chatRoomIndex = GetPrivateChatRoomIndex(currentPrivateChatRoomName);
        if (chatRoomIndex !== -1) {
          privateChatRooms[chatRoomIndex].chatRoomMembersCount =
            Math.max(0, privateChatRooms[chatRoomIndex].chatRoomMembersCount - 1);
          if (privateChatRooms[chatRoomIndex].chatRoomMembersCount <= 0) {
            privateChatRooms.splice(chatRoomIndex, 1);
          }
        }
      }
      thisUserDetails = null;
      currentPrivateChatRoomName = '';
      isJoinedToPublicRoom = false;
      isJoinedToPrivateRoom = false;
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
      isJoinedToPublicRoom = true;

      let publicChatMessages = [];
      try {
        publicChatMessages = publicChatMessagesCollection.find().slice(0, 5);
      } catch (e) {}

      clientSocket.emit('get_data', {
        data: EncryptData(JSON.stringify({
          type: "get_privious_public_chats",
          public_chats: publicChatMessages,
          is_emoji_active: config.IS_EMOJI_ACTIVE
        }))
      });
    });

    clientSocket.on('join_chat_room', function (request) {
      let newRoomName = "";
      try { newRoomName = JSON.parse(DecryptData(request)).room_name; } catch (err) { return; }

      if (currentPrivateChatRoomName && currentPrivateChatRoomName !== newRoomName) {
        clientSocket.leave(currentPrivateChatRoomName);
        const oldIndex = GetPrivateChatRoomIndex(currentPrivateChatRoomName);
        if (oldIndex !== -1) {
          privateChatRooms[oldIndex].chatRoomMembersCount = Math.max(0, privateChatRooms[oldIndex].chatRoomMembersCount - 1);
          if (privateChatRooms[oldIndex].chatRoomMembersCount <= 0)
            privateChatRooms.splice(oldIndex, 1);
        }
      }

      clientSocket.join(newRoomName);
      currentPrivateChatRoomName = newRoomName;
      isJoinedToPrivateRoom = true;

      let roomIndex = GetPrivateChatRoomIndex(newRoomName);
      if (roomIndex === -1) {
        const privateChatRoom = Object.create(PrivateChatRoomObject);
        privateChatRoom.roomName = newRoomName;
        privateChatRoom.chatRoomMembersCount = 1;
        privateChatRoom.chatsQueue = new Queue();
        privateChatRooms.push(privateChatRoom);
      } else {
        privateChatRooms[roomIndex].chatRoomMembersCount++;
      }

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
