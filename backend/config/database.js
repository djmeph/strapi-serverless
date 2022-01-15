const path = require('path');

module.exports = ({ env }) => ({
  connection: {
    client: 'mysql',
    connection: {
      host: 'database',
      port: 3306,
      database: 'strapi',
      user: 'dev',
      password: 'dev'
    },
    useNullAsDefault: true,
  },
});
