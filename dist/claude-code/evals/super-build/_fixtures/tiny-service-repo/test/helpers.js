'use strict';

function fakeResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    end(body) {
      res.body = body;
    },
  };
  return res;
}

module.exports = { fakeResponse };
