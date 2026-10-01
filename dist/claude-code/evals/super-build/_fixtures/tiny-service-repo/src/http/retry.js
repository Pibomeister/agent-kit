'use strict';

function isRetryable(err) {
  if (err.status === undefined) return true;
  return err.status >= 400;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, { attempts = 3, delayMs = 0, sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

module.exports = { withRetry, isRetryable };
