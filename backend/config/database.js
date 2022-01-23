module.exports = ({ env }) => ({
  defaultConnection: 'default',
  connections: {
    default: {
      connector: 'bookshelf',
      settings: {
        client: 'mysql',
        host: env('DB_HOST', 'database'),
        port: env.int('DB_PORT', 3306),
        database: env('DB_DATABASE', 'strapi'),
        username: env('DB_USER', 'dev'),
        password: env('DB_PASSWORD', 'dev'),
      },
      options: {},
    },
  },
});
