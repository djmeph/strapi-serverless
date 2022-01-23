/* eslint-disable no-undef */

const AWS = require('aws-sdk');
const serverless = require('serverless-http');
const startStrapi = require('strapi/lib/Strapi');

exports.handler = async (event, context) => {
  const secretsManager = new AWS.SecretsManager();
  const [credsOutput, jwtSecretOutput] = await Promise.all([
    secretsManager.getSecretValue({
      SecretId: process.env.CREDS_SECRET_ARN
    }),
    secretsManager.getSecretValue({
      SecretId: process.env.JWT_SECRET_ARN
    })
  ]);
  const creds = JSON.parse(credsOutput.SecretString);

  process.env['DB_HOST'] = creds.host;
  process.env['DB_PORT'] = `${creds.port}`;
  process.env['DB_DATABASE'] = creds.dbname;
  process.env['DB_USER'] = creds.username;
  process.env['DB_PASSWORD'] = creds.password;
  process.env['ADMIN_JWT_SECRET'] = jwtSecretOutput.SecretString;

  if (!global.strapi) {
    strapi = startStrapi({ dir: __dirname });
    await strapi.start();
  }

  const handler = serverless(global.strapi.app);
  return handler(event, context);
};
