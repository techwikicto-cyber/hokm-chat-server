module.exports = {
  LISTEN_PORT: process.env.LISTEN_PORT ? Number(process.env.LISTEN_PORT) : 3008,

  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:8081',
  
  APP_VERSION: process.env.APP_VERSION || '1.0',

  IS_LOCAL: process.env.IS_LOCAL === 'true' || true,

  PUBLIC_ROOM_NAME: process.env.PUBLIC_ROOM_NAME || 'public_chat_room',

  MAXIMUM_PUBLIC_ROOM_CHATS_LENGTH: process.env.MAXIMUM_PUBLIC_ROOM_CHATS_LENGTH ? Number(process.env.MAXIMUM_PUBLIC_ROOM_CHATS_LENGTH) : 100,
  
  MAXIMUM_PRIVATE_ROOM_CHATS_LENGTH: process.env.MAXIMUM_PRIVATE_ROOM_CHATS_LENGTH ? Number(process.env.MAXIMUM_PRIVATE_ROOM_CHATS_LENGTH) : 100,
  
  AES_ENCRYPTION_SECRET_KEY: process.env.AES_ENCRYPTION_SECRET_KEY || 'p2s5v8y/B?E(H+MbPeShVmYq3t6w9z$C',

  REDIS_IP: process.env.REDIS_IP || '127.0.0.1',

  REDIS_PORT: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,

  // ←←← این خط مهم است
  SHOULD_USE_NGINX_REDIS: process.env.SHOULD_USE_NGINX_REDIS === 'true',

  IS_EMOJI_ACTIVE: process.env.IS_EMOJI_ACTIVE === 'true' || true,

  MYSQL_HOST: process.env.MYSQL_HOST || 'localhost',
  MYSQL_USER: process.env.MYSQL_USER || 'hokm_user',
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD || '8mV4t9+&2K',
  MYSQL_DATABASE_NAME: process.env.MYSQL_DATABASE_NAME || 'hokm'
};
