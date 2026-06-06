const Queue = require('../classes/queue');

const ParivateChatRoomObject = {
    roomName: '',
    chatRoomMembersCount: 0,
    chatsQueue: new Queue()
  };

module.exports = ParivateChatRoomObject;