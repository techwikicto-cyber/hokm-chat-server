const mongoose = require("mongoose");

const MongoPublicChat = mongoose.model(
  "MongoPublicChat",
  new mongoose.Schema({
    chat_message_body: String,
    chat_message_time: Number,
    user_id: String,
    user_name: String
  })
);

module.exports = MongoPublicChat;