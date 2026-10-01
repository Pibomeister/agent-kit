import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const port = 43191;
const child = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: "ignore",
});

try {
  let response;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/health`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  if (!response) throw new Error("service did not become ready");
  const body = await response.text();
  const bodyDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  console.log(JSON.stringify({ status: response.status, body_digest: bodyDigest, body }));
  if (response.status !== 200 || JSON.parse(body).status !== "healthy") process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
