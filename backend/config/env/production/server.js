module.exports = ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  url: env('STRAPI_URL', 'http://localhost:1337'),
  admin: {
    serveAdminPanel: env.bool('SERVE_ADMIN', true),
    autoOpen: false,
    url: '/',
    auth: {
      secret: env('ADMIN_JWT_SECRET', 'ywGVzeJPrr6N2VV5c72W'),
    },
  },
});
