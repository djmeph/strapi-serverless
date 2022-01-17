const path = require('path');

const { SecretsManager } = require('@aws-sdk/client-secrets-manager');

module.exports = ({ env }) => ({
  connection: {
    client: 'mysql',
    connection: {
      host: env('DB_HOST', 'database'),
      port: env.int('DB_PORT', 3306),
      database: env('DB_DATABASE', 'strapi'),
      user: env('DB_USER', 'dev'),
      password: env('DB_PASSWORD', 'dev'),
    },
    debug: false
  },
});
