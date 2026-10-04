# Transport: direct

Loaded by `super-ship publish` when the push and the pull request go straight to the forge through
`git` and the forge's command-line client, with no gate and no supervisor between them. The authority
for every rule here is ruling `direct-push-as-ship-transport` and
`adapters/runner-contract/CONTRACT.md` §5; this file is the operating form of them. The commands are
GitHub's `gh`. Another forge's client stands in only where it gives the same exit-status guarantees;
where it does not, every lookup below is unknown and the run stops.

## Contents

- What the transport is
- Choosing it
- Before any remote call
- The commit
- The push
- The pull request
- What it never does

## What the transport is

super-ship has already decided: receipts and a verdict bind to the head being shipped. This transport
commits, pushes and opens the pull request, and nothing else. No pipeline re-runs the project's checks
on the head afterwards, so the re-check is super-ship's own: the release checks of workflow step 5,
each recorded against this head, with a check that did not run recorded as not run. super-ship stays
the single creator of the pull request.

## Choosing it

The transport is named, never inferred from whichever one happens to work. The first of these that
names one decides:

1. A Firstmate binding: its `delivery.transport`, which is always `no-mistakes`. A bound run never
   ships direct.
2. The project's own conventions: its instruction files, and the conventions the knowledgebase
   adapter's `readContext` returns. A project that routes its changes through a gate is never pushed
   around it, whoever asks, and a gate this package has no transport for stops the ship with
   `needs-input`. Where `readContext` is unavailable, the instruction files are the conventions and
   the ship record says the knowledgebase went unread.
3. The caller's `transport` input: `direct` or `no-mistakes`.
4. None of them: stop with `needs-input` naming the choice. No gate in sight is not a choice of
   direct; a transport nothing names is unknown, and unknown is not direct.

The choice holds for the run. A no-mistakes transport that was chosen but is not configured stops
the ship before the push, as that transport's own rules require; it never falls back to this one. In
`dry-run` the choice is made from local reads alone, so the report can name where the payload would
have gone.

## Before any remote call

1. The branch: `git branch --show-current`. Empty output is a detached head, and the base branch is
   not a branch to ship from; either stops with `needs-input` naming the branch to create. The lookup
   below with an empty branch drops its filter and lists unrelated pull requests.
2. The remote, `<remote>`: `origin`, unless the conventions name another. The base repository is the
   one the pull request targets, `<base-owner>/<repo>`: the remote's own repository, or on a fork
   checkout the repository it was forked from — named by the conventions, a remote that fetches it,
   or in `publish` the fork's `parent` from `gh repo view <fork-owner>/<repo> --json isFork,parent`.
   The head owner is the remote's owner, `<fork-owner>` on a fork. Every `gh` call below passes `-R
   <base-owner>/<repo>`, so none of them falls to `gh`'s own choice of default repository.
3. The base: the branch the conventions name for this one, which may depend on its prefix. Where
   they name none, the base repository's default branch — `git symbolic-ref --short
   refs/remotes/<base-remote>/HEAD` locally, for the remote that fetches the base repository, with
   its `<base-remote>/` prefix stripped so the base is the bare branch name, and `gh repo view
   <base-owner>/<repo> --json defaultBranchRef` in `publish`. A fork's own default branch is never
   the base. With neither, stop with `needs-input`; a base is never guessed. The ship record says
   which source gave it.
4. The assignee and the body shape: a required assignee, and the template the body must follow — the
   repository's own pull-request template, or the shape the conventions give. Where the conventions
   require no assignee, the flag is left out rather than filled. Nothing here is a package default.

## The commit

1. Record what is staged for the named paths: `git ls-files --stage -- <path>...` gives each one's
   mode and blob.
2. Require the working tree to match the index for those paths: `git diff --quiet -- <path>...`.
   Exit 0 is a match. Exit 1 is a path partially staged or edited after staging, and stops with
   `needs-input` naming the paths `git diff --name-only -- <path>...` lists; any other exit is
   unknown: stop. The commit below takes the working-tree content of the paths it names, so a
   difference here would replace what was staged.
3. Commit only those paths: `git commit -F <message-file> -- <path>...`. The trailing path list keeps
   anything else already in the index out of the commit.
4. The project's hooks run. Never pass `--no-verify`: a hook is one of the project's own checks.
5. Compare what the commit holds. `git ls-tree -r HEAD -- <path>...` must list the modes and blobs
   step 1 recorded, and `git diff --name-only HEAD^ HEAD` must name no path outside the named ones.
   Equal: the commit is what was verified. Different: the commit no longer holds what was staged — a
   hook that reformats and restages files is the usual cause, though not the only one — and the
   commit is a new head that no receipt or verdict binds to. Stop before the push with
   `needs-input`. The commit stays local and is neither amended nor pushed. `ship-preflight` has
   already closed the run, so the new head needs a new run: `open` again, re-run super-build,
   super-verify and super-review for it, and it ships again once workflow step 3's gate check passes.
6. A hook that changes files without staging them leaves the commit as verified and the working tree
   changed. Report those paths and leave them uncommitted.

A project whose hooks format on commit ships cleanly when those formatters run before super-verify,
so the hook has nothing left to rewrite.

## The push

Reconcile before the effect, per `adapters/runner-contract/CONTRACT.md` §5:

1. Re-read `git branch --show-current`. It must be the branch resolved above.
2. Read the remote branch: `git ls-remote --exit-code <remote> refs/heads/<branch>`. Exit 0 prints its
   commit, exit 2 means it does not exist there, and any other exit is unknown: stop.
3. The remote branch already at the shipped commit: the push is done. Record it and do not push again.
4. The remote branch at another commit: fetch it (`git fetch <remote> refs/heads/<branch>`) where it is
   not local, then `git merge-base --is-ancestor <remote-commit> HEAD`. Exit 0 is a fast-forward.
   Exit 1 is a diverged branch, and any other exit is unknown; both stop with `needs-input`. A
   diverged branch is never forced into line: force-push is a sensitive action (ruling
   `sensitive-actions-need-approved-charter-entry`).
5. Push: `git push -u <remote> <branch>`. Never `--force`, `--force-with-lease` or `--no-verify`. A
   rejected push, including a pre-push hook that fails, is `failed` with the reason, and the run stays
   resumable.
6. Read back with the step 2 command. It must print the shipped commit; anything else is `failed`,
   never complete.

## The pull request

1. Look it up: `gh pr list -R <base-owner>/<repo> --head <branch> --state open --json
   number,url,headRefName,headRefOid,headRepositoryOwner,baseRefName`. Pass the branch name only:
   `--head <owner>:<branch>` is not accepted and returns `[]`, which reads as none.
2. Only exit 0 with `[]` means none (workflow step 8). Any other exit is unknown: stop.
3. A row whose head owner or branch is not this head's is another contributor's pull request. More
   than one row matching this head is ambiguous: stop and list them rather than taking the first.
4. One match: the push updated it. Its `baseRefName` must be the base resolved above, and a different
   base stops with `needs-input` rather than being edited. Return it; never open a second.
5. None: write the body to a temporary file outside the repository and create the pull request with
   `gh pr create -R <base-owner>/<repo> --base <base> --head <head> --title <title> --body-file
   <file>`, where `<head>` is `<fork-owner>:<branch>` on a fork and `<branch>` otherwise, adding
   `--assignee <who>` where the conventions require one. Never pass the body on standard input: `gh`
   can open a pull request with an empty body and still exit 0.
6. Repeat the lookup immediately before the create. A pull request that appeared since step 1 takes
   the one-match path.
7. Read back with the step 1 lookup: exactly one matching row, whose `headRefOid` is the shipped
   commit. Anything else is `failed`.

The ship record carries each effect's idempotency key and both read-backs. A resumed run re-derives
the same keys. A head that already carries the commit is past the commit, and the push and
pull-request reconciles return an effect already made rather than repeating it.

## What it never does

It never merges, never deploys, never force-pushes, never rewrites history on the remote and never
pushes the base branch. It never skips a hook and never falls back from a gate that was chosen. Merge
authority stays with whoever holds it: standalone, the person.
