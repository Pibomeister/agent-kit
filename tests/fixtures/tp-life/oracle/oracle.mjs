#!/usr/bin/env bun
/**
 * TP-LIFE oracle. Talks HTTP only. Does not import the fixture service.
 * Expected states come from research/tp-life/spec-v2.md, not from server code.
 */
const CASES = ["pending", "success", "failure", "disconnect", "duplicate"];

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function fail(id, detail) {
  return { id, verdict: "fail", detail };
}

function pass(id, detail) {
  return { id, verdict: "pass", detail };
}

async function postJob(base, key, op) {
  const res = await fetch(`${base}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: key, op }),
  });
  const body = await res.json();
  return { http: res.status, body };
}

async function getJob(base, id, init) {
  const res = await fetch(`${base}/jobs/${id}`, init);
  const body = await res.json();
  return { http: res.status, body };
}

function jobId(created) {
  if (created.http >= 400) return undefined;
  const id = created.body.id;
  if (id === undefined || id === null || String(id).length === 0) return undefined;
  return String(id);
}

async function runPending(base) {
  const created = await postJob(base, "pend-1", "hang");
  const id = jobId(created);
  if (id === undefined) return fail("pending", "submit of hang job was rejected");
  const first = await getJob(base, id);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = await getJob(base, id);
  if (first.body.status !== "pending" || second.body.status !== "pending") {
    return fail("pending", `wanted pending then pending, got ${first.body.status} then ${second.body.status}`);
  }
  return pass("pending", "hang job stayed pending across two polls");
}

async function runSuccess(base) {
  const created = await postJob(base, "ok-1", "succeed");
  const id = jobId(created);
  if (id === undefined) return fail("success", "submit of succeed job was rejected");
  const got = await getJob(base, id);
  if (got.body.status !== "success") return fail("success", `wanted success, got ${got.body.status}`);
  return pass("success", "succeed job reached success");
}

async function runFailure(base) {
  const created = await postJob(base, "fail-1", "fail");
  const id = jobId(created);
  if (id === undefined) return fail("failure", "submit of fail job was rejected");
  const got = await getJob(base, id);
  if (got.body.status !== "failure") return fail("failure", `wanted failure, got ${got.body.status}`);
  return pass("failure", "fail job reached failure");
}

async function runDisconnect(base) {
  const created = await postJob(base, "disc-1", "hang");
  const id = jobId(created);
  if (id === undefined) return fail("disconnect", "submit of hang job was rejected");
  const ac = new AbortController();
  const aborted = getJob(base, id, { signal: ac.signal });
  ac.abort();
  try {
    await aborted;
  } catch {
    // The in-flight poll was cancelled. The job must still be readable.
  }
  const got = await getJob(base, id);
  if (got.http !== 200 || got.body.id !== id) {
    return fail("disconnect", "job missing after an aborted poll");
  }
  if (got.body.status !== "pending") {
    return fail("disconnect", `wanted pending after reconnect, got ${got.body.status}`);
  }
  return pass("disconnect", "aborted poll left the hang job readable as pending");
}

async function runDuplicate(base) {
  const first = await postJob(base, "dup-1", "succeed");
  const second = await postJob(base, "dup-1", "succeed");
  const a = jobId(first);
  const b = jobId(second);
  if (a === undefined || b === undefined) return fail("duplicate", "duplicate submit was rejected");
  if (a !== b) return fail("duplicate", `same idempotency_key created ${a} then ${b}`);
  return pass("duplicate", "same idempotency_key returned the original job");
}

const runners = {
  pending: runPending,
  success: runSuccess,
  failure: runFailure,
  disconnect: runDisconnect,
  duplicate: runDuplicate,
};

async function main() {
  const argv = process.argv.slice(2);
  const base = argValue(argv, "--base-url");
  const out = argValue(argv, "--out");
  if (base === undefined || base.length === 0) {
    process.stderr.write("usage: oracle.mjs --base-url http://127.0.0.1:PORT [--out report.json]\n");
    process.exit(2);
  }
  const cases = [];
  for (const id of CASES) {
    cases.push(await runners[id](base.replace(/\/$/, "")));
  }
  let passed = 0;
  let failed = 0;
  for (const row of cases) {
    if (row.verdict === "pass") passed += 1;
    else failed += 1;
  }
  const report = { passed, failed, cases };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out !== undefined) await Bun.write(out, text);
  process.stdout.write(text);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
