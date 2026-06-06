const mongoose = require("mongoose");

const MongoPrivateChat = mongoose.model(
  "MongoPrivateChat",
  new mongoose.Schema({
    chat_room_id: String,
    chat_message_body: String,
    chat_message_time: Number,
    user_id: String,
    user_name: String
  })
);

module.exports = MongoPrivateChat;