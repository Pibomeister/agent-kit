#!/usr/bin/env bun
/**
 * TP-LIFE oracle. Talks HTTP only. Does not import the fixture service.
 * Expected states come from research/tp-life/spec-v2.md, not from server code.
 */
const CASES = ["pending", "success", "failure", "disconnect", "duplicate", "unknown"];
const FETCH_MS = 4000;
const POLL_DEADLINE_MS = 1500;
const POLL_EVERY_MS = 40;
const TERMINAL = new Set(["success", "failure"]);

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchSignal(extra) {
  const timeout = AbortSignal.timeout(FETCH_MS);
  if (extra === undefined) return timeout;
  return AbortSignal.any([timeout, extra]);
}

function runKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function postJob(base, key, op) {
  const res = await fetch(`${base}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: key, op }),
    signal: fetchSignal(),
  });
  const body = await res.json();
  return { http: res.status, body };
}

async function getJob(base, id, init) {
  const extra = init === undefined ? undefined : init.signal;
  const res = await fetch(`${base}/jobs/${id}`, {
    signal: fetchSignal(extra),
  });
  const body = await res.json();
  return { http: res.status, body };
}

function jobId(created) {
  if (created.http >= 400) return undefined;
  const id = created.body.id;
  if (id === undefined || id === null || String(id).length === 0) return undefined;
  return String(id);
}

async function pollUntil(base, id, want, firstStatus) {
  const seen = firstStatus === undefined ? [] : [firstStatus];
  const start = Date.now();
  let last = { http: 0, body: { status: firstStatus } };
  if (firstStatus === want) return { last, seen };
  if (TERMINAL.has(firstStatus) && firstStatus !== want) return { last, seen };
  while (Date.now() - start < POLL_DEADLINE_MS) {
    last = await getJob(base, id);
    seen.push(last.body.status);
    if (last.body.status === want) return { last, seen };
    if (TERMINAL.has(last.body.status)) return { last, seen };
    await sleep(POLL_EVERY_MS);
  }
  return { last, seen };
}

function sawPendingThen(seen, terminal) {
  let pending = false;
  for (const status of seen) {
    if (status === "pending") pending = true;
    if (status === terminal && pending) return true;
  }
  return false;
}

async function runPending(base, key) {
  const created = await postJob(base, `pend-${key}`, "hang");
  const id = jobId(created);
  if (id === undefined) return fail("pending", "submit of hang job was rejected");
  const first = created.body.status === "pending" ? created : await getJob(base, id);
  await sleep(40);
  const second = await getJob(base, id);
  if (first.body.status !== "pending" || second.body.status !== "pending") {
    return fail("pending", `wanted pending then pending, got ${first.body.status} then ${second.body.status}`);
  }
  return pass("pending", "hang job stayed pending across two polls");
}

async function runSuccess(base, key) {
  const created = await postJob(base, `ok-${key}`, "succeed");
  const id = jobId(created);
  if (id === undefined) return fail("success", "submit of succeed job was rejected");
  const poll = await pollUntil(base, id, "success", created.body.status);
  if (!sawPendingThen(poll.seen, "success")) {
    return fail("success", `wanted pending then success, got ${poll.seen.join(",") || "no polls"}`);
  }
  return pass("success", "succeed job was pending then success");
}

async function runFailure(base, key) {
  const created = await postJob(base, `fail-${key}`, "fail");
  const id = jobId(created);
  if (id === undefined) return fail("failure", "submit of fail job was rejected");
  const poll = await pollUntil(base, id, "failure", created.body.status);
  if (!sawPendingThen(poll.seen, "failure")) {
    return fail("failure", `wanted pending then failure, got ${poll.seen.join(",") || "no polls"}`);
  }
  return pass("failure", "fail job was pending then failure");
}

async function runDisconnect(base, key) {
  const created = await postJob(base, `disc-${key}`, "hang");
  const id = jobId(created);
  if (id === undefined) return fail("disconnect", "submit of hang job was rejected");
  const ac = new AbortController();
  try {
    const res = await fetch(`${base}/jobs/${id}?slow=1`, { signal: fetchSignal(ac.signal) });
    const reader = res.body === null ? undefined : res.body.getReader();
    if (reader === undefined) return fail("disconnect", "slow poll had no body to abort");
    await reader.read();
    ac.abort();
    await reader.read();
    return fail("disconnect", "poll completed without abort");
  } catch {
    // The in-flight poll was cancelled after the server accepted it.
  }
  if (!ac.signal.aborted) return fail("disconnect", "poll completed without abort");
  const got = await getJob(base, id);
  if (got.http !== 200 || got.body.id !== id) {
    return fail("disconnect", "job missing after an aborted poll");
  }
  return pass("disconnect", "aborted poll left the job readable");
}

async function runDuplicate(base, key) {
  const first = await postJob(base, `dup-${key}`, "succeed");
  const second = await postJob(base, `dup-${key}`, "succeed");
  const a = jobId(first);
  const b = jobId(second);
  if (a === undefined || b === undefined) return fail("duplicate", "duplicate submit was rejected");
  if (a !== b) return fail("duplicate", `same idempotency_key created ${a} then ${b}`);
  return pass("duplicate", "same idempotency_key returned the original job");
}

async function runUnknown(base, key) {
  const got = await getJob(base, `job-missing-404-${key}`);
  if (got.http !== 404) return fail("unknown", `wanted 404, got ${got.http}`);
  return pass("unknown", "unknown id returned 404");
}

const runners = {
  pending: runPending,
  success: runSuccess,
  failure: runFailure,
  disconnect: runDisconnect,
  duplicate: runDuplicate,
  unknown: runUnknown,
};

async function runCase(id, base, key) {
  try {
    return await runners[id](base, key);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(id, detail.length > 0 ? detail : "case threw");
  }
}

function uniqueComplete(cases) {
  if (cases.length !== CASES.length) return false;
  const seen = new Set();
  for (const row of cases) {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
  }
  for (const id of CASES) {
    if (!seen.has(id)) return false;
  }
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  const baseArg = argValue(argv, "--base-url");
  const out = argValue(argv, "--out");
  if (baseArg === undefined || baseArg.length === 0) {
    process.stderr.write("usage: oracle.mjs --base-url http://127.0.0.1:PORT [--out report.json]\n");
    process.exit(2);
  }
  const base = baseArg.replace(/\/$/, "");
  const key = runKey();
  const started = new Date();
  const cases = [];
  for (const id of CASES) {
    cases.push(await runCase(id, base, key));
  }
  if (!uniqueComplete(cases)) {
    process.stderr.write("tp-life oracle: case ids are not a unique complete set\n");
    process.exit(2);
  }
  let passed = 0;
  let failed = 0;
  for (const row of cases) {
    if (row.verdict === "pass") passed += 1;
    else failed += 1;
  }
  const report = {
    base_url: base,
    started_at: started.toISOString(),
    duration_ms: Date.now() - started.getTime(),
    passed,
    failed,
    cases,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out !== undefined) await Bun.write(out, text);
  process.stdout.write(text);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
