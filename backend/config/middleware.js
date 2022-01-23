module.exports = {
  settings: {
    parser: {
      enabled: true,
      multipart: true,
      formidable: {
        maxFileSize: 10000000,
      },
    },
  },
};
