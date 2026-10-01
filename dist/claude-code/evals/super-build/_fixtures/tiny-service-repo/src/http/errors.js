'use strict';

function httpError(status, message = `request failed with ${status}`) {
  return Object.assign(new Error(message), { status });
}

module.exports = { httpError };
