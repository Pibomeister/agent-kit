# Tool-less distiller command

`chat-distiller.ts` sends the stage's stdin prompt in one chat-API request. It offers no tools,
starts no agent runtime and makes no retries. stdout contains `{"result": ..., "usage": ...}`.
The stage parses and scrubs the result. An invalid result keeps that request's excerpts.

Set these variables outside the repository:

| Variable | Value |
|---|---|
| `AK_LEARN_DISTILL_API_URL` | Full HTTPS chat endpoint. HTTP is accepted only for loopback tests |
| `AK_LEARN_DISTILL_API_MODEL` | Operator-selected identifier |
| `AK_LEARN_DISTILL_API_KEY_FILE` | Absolute path to an owner-readable file containing the API credential |
| `AK_LEARN_DISTILL_API_REASONING` | Optional provider reasoning setting; omitted when unset |
| `AK_LEARN_DISTILL_CODEX`, `AK_LEARN_DISTILL_GROK`, `AK_LEARN_DISTILL_KIMI` | Each selected host's command: absolute Bun path followed by the script's absolute path |

The command requests at most 4,096 completion tokens and times out after 60 seconds.
It rejects redirects, incomplete responses and unexpected tool calls. It never prints provider
error bodies or thrown transport errors, which may contain credentials or session text.
Usage comes from the provider; no price or cost is inferred.

For an installation independent of a disposable checkout, build a standalone command with
`bun build tools/learn/chat-distiller.ts --target=bun --outfile <operator-path>` and bind that path.
Keep provider settings and credentials out of the checkout and out of command arguments.
Scheduler units carry the `AK_LEARN_*` environment present when written; the credential variable
names its file, so the unit does not need the credential value. Enable a schedule only after the
change ships and the operator authorizes its paths and paid check. Loading the existing learning
unit starts a memory tick immediately; it is unsuitable when that tick is not authorized.
