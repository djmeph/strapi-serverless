module.exports = ({ env }) => ({
  apiToken: {
    salt: env('API_TOKEN_SALT', 'n9xQ3uE9HdYiSL2sqBog'),
  },
  auth: {
    events: {
      onConnectionSuccess(e) {
        console.log(e.user, e.provider);
      },
      onConnectionError(e) {
        console.error(e.error, e.provider);
      },
    },
    secret: env('ADMIN_JWT_SECRET', 'sjT119tqduRW1yhSX8z3'),
  },
  url: env('PUBLIC_ADMIN_URL', '/admin'),
  autoOpen: false,
  serveAdminPanel: env.bool('SERVE_ADMIN', true),
});
