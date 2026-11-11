# Job poller, specification v2

Authorized revision of `research/tp-life/spec-v1.md`. Duplicate submission is
no longer open.

## Submit

`POST /jobs` with JSON `{ "idempotency_key": string, "op": "succeed" | "fail" | "hang" }`.

`succeed` reaches `success`. `fail` reaches `failure`. `hang` stays `pending`.

A second POST with an `idempotency_key` the service already holds returns that
original job and does not create another. The HTTP status may be 200 or 201.
The `id` must match.

## Poll

`GET /jobs/{id}` returns `{ "id", "status" }` with `status` one of `pending`,
`success`, `failure`. Unknown ids are 404.

The frontend polls `GET /jobs/{id}` until a terminal status. An aborted poll,
then a later GET of the same id, still returns that job.

`GET /jobs/{id}?slow=1` is the fixture's test hook. It writes a 200 and delays
the body so a client can abort mid-poll. Production clients do not send `slow`.

## Oracle

An independent process that only uses HTTP must observe:

1. pending: a hang job stays `pending` across two polls
2. success: a succeed job is `pending`, then `success`
3. failure: a fail job is `pending`, then `failure`
4. disconnect: abort one GET after the server has accepted it, then GET again, job still present
5. duplicate: two POSTs with the same key return the same `id`
6. unknown: GET of an id the service does not hold returns 404
