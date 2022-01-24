const startStrapi = require('strapi/lib/Strapi');
const { SecretsManager } = require('@aws-sdk/client-secrets-manager');

(async () => {
  const secretsManager = new SecretsManager({});
  const [credsOutput, jwtSecretOutput] = await Promise.all([
    secretsManager.getSecretValue({
      SecretId: process.env.CREDS_SECRET_ARN
    }),
    secretsManager.getSecretValue({
      SecretId: process.env.JWT_SECRET_ARN
    }),
  ]);
  const creds = JSON.parse(credsOutput.SecretString);

  process.env['DB_HOST'] = creds.host;
  process.env['DB_PORT'] = `${creds.port}`;
  process.env['DB_DATABASE'] = creds.dbname;
  process.env['DB_USER'] = creds.username;
  process.env['DB_PASSWORD'] = creds.password;
  process.env['ADMIN_JWT_SECRET'] = jwtSecretOutput.SecretString;

  let strapi;
  if (!global.strapi) {
    strapi = startStrapi({ dir: __dirname });
  }
  await strapi.start();
})();
