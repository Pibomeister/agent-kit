# Job poller, specification v1

A small job service. Clients submit work and poll until it finishes.

## Submit

`POST /jobs` with JSON `{ "idempotency_key": string, "op": "succeed" | "fail" | "hang" }`.

`op` selects the outcome the job is meant to reach. `hang` stays unfinished so a
client can observe a pending poll.

## Poll

`GET /jobs/{id}` returns `{ "id", "status" }` where `status` is `pending`,
`success`, or `failure`. Clients poll until `status` is `success` or `failure`.
A dropped poll must not delete the job.

## Duplicate requests

If the same request is sent twice, the service handles it.

That sentence is the deliberate gap. It does not say whether a second POST with
the same `idempotency_key` returns the original job or creates another.
