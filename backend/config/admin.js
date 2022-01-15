module.exports = ({ env }) => ({
  auth: {
    secret: env('ADMIN_JWT_SECRET', 'd629ef7d0bd8808fdee8d649ce287474'),
  },
});
