const UserObject = require('./user-object');

const ChatMessageObject = {
    sender_details: UserObject,
    message: String,
    message_time: Number,
    is_emoji_active: Boolean
  };

module.exports = ChatMessageObject;