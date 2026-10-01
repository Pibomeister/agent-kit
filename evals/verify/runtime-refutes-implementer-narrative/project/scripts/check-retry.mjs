import { requestWithRetry } from "../retry.mjs";

const result = await requestWithRetry(async () => ({ status: 400 }));
console.log(JSON.stringify({ status: result.response.status, request_count: result.calls }));
if (result.calls !== 1) process.exitCode = 1;
