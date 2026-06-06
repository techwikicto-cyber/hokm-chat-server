const mongoose = require('mongoose');
mongoose.Promise = global.Promise;

const db = {};

db.mongoose = mongoose;

db.mongo_public_chat = require("./mongo-public-chat-model");
db.mongo_private_chat = require("./mongo-private-chat-model");

module.exports = db;