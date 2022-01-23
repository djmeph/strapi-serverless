module.exports = ({ env }) => ({
  upload: {
    enabled: env('AWS_S3_ENABLED', false),
    config: {
      provider: 'strapi-provider-upload-aws-s3-advanced',
      providerOptions: {
        region: env('AWS_REGION'),
        params: {
          bucket: env('ASSETS_BUCKET'),
        },
        baseUrl: env('CDN_BASE_URL'),
        prefix: env('BUCKET_PREFIX'),
      },
    },
  },
});
