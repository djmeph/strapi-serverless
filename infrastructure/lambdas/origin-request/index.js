exports.handler = async (event) => {
  const { request } = event.Records[0].cf;
  const uriParts = request.uri.split("/");

  if (uriParts[1] !== 'admin') {
    request.uri = '/admin/index.html';
  }

  return request;
};
