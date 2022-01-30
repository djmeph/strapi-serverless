module.exports = ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  url: env('STRAPI_URL'),
  admin: {
    serveAdminPanel: env.bool('SERVE_ADMIN', true),
    autoOpen: false,
    url: env('STRAPI_ADMIN_URL', '/admin'),
    auth: {
      secret: env('ADMIN_JWT_SECRET', 'ywGVzeJPrr6N2VV5c72W'),
    },
  },
});
