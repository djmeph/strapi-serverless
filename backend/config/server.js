module.exports = ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  admin: {
    autoOpen: false,
    auth: {
      secret: env('ADMIN_JWT_SECRET', 'sjT119tqduRW1yhSX8z3'),
    },
  },
});
