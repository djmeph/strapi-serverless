exports.handler = async (event) => {
  const {
    response,
    request: {
      origin: {
        s3: { customHeaders },
      },
    },
  } = event.Records[0].cf;
  const { value: apiUri } = customHeaders['x-api-uri'][0];

  response.headers['access-control-allow-origin'] = [
    {
      key: 'Access-Control-Allow-Origin',
      value: apiUri,
    },
  ];

  response.headers['access-control-allow-methods'] = [
    {
      key: 'Access-Control-Allow-Methods',
      value: 'OPTIONS, GET, HEAD, POST, PUT, DELETE',
    },
  ];

  response.headers['access-control-max-age'] = [
    { key: 'Access-Control-Max-Age', value: '86400' },
  ];

  return response;
};