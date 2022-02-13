const { APIGateway } = require('aws-sdk');

exports.handler = async (event) => {
  const apiGateway = new APIGateway();
  await apiGateway.flushStageCache({
    restApiId: process.env.REST_API_ID,
    stageName: process.env.STAGE_NAME
  }).promise();
  return {};
};
