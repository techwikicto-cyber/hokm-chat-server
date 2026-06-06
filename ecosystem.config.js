module.exports = {
  apps: [
    {
      name: "hokm-chat",
      script: "./simple-chat-server.js",

      instances: "2",
      exec_mode: "cluster",

      watch: false,

      env: {
	SERVICE_NAME: "hokm",      
        NODE_ENV: "production",

        SHOULD_USE_NGINX_REDIS: "true",

        REDIS_IP: "127.0.0.1",
        REDIS_PORT: "6379",

        LISTEN_PORT: "3008",
        IS_LOCAL: "false",
      },
    },
  ],
};
