#!/usr/bin/env bun
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "public/index.html"));
const argv = process.argv.slice(2);
const BROKEN = new Set(["pending", "success", "failure", "disconnect", "duplicate", "unknown"]);
const FINISH_MS = 80;
const SLOW_BODY_MS = 1500;

let port = Number(process.env.PORT ?? 0);
let broken = process.env.AK_TP_LIFE_BROKEN ?? "";
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--port") {
    i += 1;
    port = Number(argv[i]);
  } else if (argv[i] === "--broken") {
    i += 1;
    broken = String(argv[i] ?? "");
  }
}
if (broken !== "" && !BROKEN.has(broken)) {
  process.stderr.write(`tp-life fixture: unknown --broken ${broken}\n`);
  process.exit(2);
}

/** @typedef {{ id: string, idempotency_key: string, op: string, status: string }} Job */

/** @type {Map<string, Job>} */
const jobs = new Map();
/** @type {Map<string, string>} */
const byKey = new Map();
let next = 1;

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function scheduleFinish(job) {
  if (broken === "success" && job.op === "succeed") return;
  if (broken === "failure" && job.op === "fail") {
    setTimeout(() => {
      job.status = "success";
    }, FINISH_MS);
    return;
  }
  if (job.op === "succeed") {
    setTimeout(() => {
      job.status = "success";
    }, FINISH_MS);
    return;
  }
  if (job.op === "fail") {
    setTimeout(() => {
      job.status = "failure";
    }, FINISH_MS);
  }
}

const server = createServer((req, res) => {
  void handle(req, res);
});

async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (req.method === "GET" && url.pathname === "/contract") {
    sendJson(res, 200, {
      submit: { method: "POST", path: "/jobs" },
      poll: {
        method: "GET",
        path: "/jobs/{id}",
        interval_ms: 25,
        pending: "pending",
        terminal: ["success", "failure"],
      },
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/jobs") {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    const key = body.idempotency_key;
    const op = body.op;
    if (key === undefined || key === null || String(key).length === 0) {
      sendJson(res, 400, { error: "idempotency_key required" });
      return;
    }
    if (op !== "succeed" && op !== "fail" && op !== "hang") {
      sendJson(res, 400, { error: "op must be succeed, fail, or hang" });
      return;
    }
    const keyText = String(key);
    if (broken !== "duplicate") {
      const existing = byKey.get(keyText);
      if (existing !== undefined) {
        sendJson(res, 200, jobs.get(existing));
        return;
      }
    }
    const id = `job-${next}`;
    next += 1;
    const job = { id, idempotency_key: keyText, op, status: "pending" };
    jobs.set(id, job);
    byKey.set(keyText, id);
    scheduleFinish(job);
    sendJson(res, 201, job);
    return;
  }
  const match = /^\/jobs\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && match !== null) {
    const job = jobs.get(match[1]);
    if (job === undefined) {
      if (broken === "unknown") {
        sendJson(res, 200, { id: match[1], status: "pending" });
        return;
      }
      sendJson(res, 404, { error: "unknown job" });
      return;
    }
    // A hang stays pending. The broken pending fault is that it does not: the
    // oracle's second poll must already see success. A short timer loses that
    // race whenever this process is scheduled late, and the case then passes.
    if (broken === "pending" && job.op === "hang") job.status = "success";
    if (url.searchParams.get("slow") === "1") {
      let finished = false;
      res.writeHead(200, { "content-type": "application/json" });
      res.write(" ");
      const drop = () => {
        if (!finished && broken === "disconnect") {
          jobs.delete(job.id);
          byKey.delete(job.idempotency_key);
        }
      };
      req.on("aborted", drop);
      req.on("close", drop);
      res.on("close", drop);
      if (broken === "disconnect") {
        drop();
        req.destroy();
        return;
      }
      setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        finished = true;
        res.end(JSON.stringify(job));
      }, SLOW_BODY_MS);
      return;
    }
    sendJson(res, 200, job);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = addr !== null && "port" in addr ? addr.port : port;
  process.stdout.write(`tp-life fixture listening on http://127.0.0.1:${actual}\n`);
});
