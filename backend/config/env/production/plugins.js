module.exports = ({ env }) => ({
  upload: {
    provider: 'aws-s3',
    providerOptions: {
      params: {
        Bucket: env('ASSETS_BUCKET'),
      },
    },
  },
});
