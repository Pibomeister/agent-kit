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
2. The remote, `<remote>`: `origin`, unless the conventions name another. Resolve its destination
   with `git remote get-url --push --all <remote>`, including Git's URL rewrites. Require exit 0 and
   exactly one URL, `<push-url>`; otherwise stop with `needs-input`. Resolve that URL's repository,
   `<head-owner>/<head-repo>`, from conventions and in `publish` confirm it with `gh repo view
   <head-owner>/<head-repo> --json id,nameWithOwner,isFork,parent`. Record its node ID as `<head-id>`.
   Require a successful lookup that confirms the identity and a non-empty ID; otherwise stop.
   The fetch URL never decides the head repository or owner. The base repository is the pull
   request's target, `<base-owner>/<repo>`: named by conventions, else the push repository's fork
   parent from that metadata, else the push repository itself. Every PR lookup and edit passes
   `-R <base-owner>/<repo>`; creation uses the resolved repository IDs. A local base-branch lookup
   uses only a remote that fetches that repository.
3. The base: the branch the conventions name for this one, which may depend on its prefix. Where
   they name none, the base repository's default branch — `git symbolic-ref --short
   refs/remotes/<base-remote>/HEAD` locally, for the remote that fetches the base repository, with
   its `<base-remote>/` prefix stripped so the base is the bare branch name, and `gh repo view
   <base-owner>/<repo> --json defaultBranchRef` in `publish`. A fork's own default branch is never
   the base. With neither, stop with `needs-input`; a base is never guessed. The ship record says
   which source gave it. In `publish`, also resolve `<base-id>` with `gh repo view
   <base-owner>/<repo> --json id,nameWithOwner`, regardless of the branch's source. Require a
   successful lookup confirming that repository and a non-empty node ID before any push.
4. The assignee and the body shape: a required assignee, and the template the body must follow — the
   repository's own pull-request template, or the shape the conventions give. Where the conventions
   require no assignee, nothing is assigned. Nothing here is a package default.

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

1. Re-read `git branch --show-current` and `git remote get-url --push --all <remote>`. They must
   still be the resolved branch and sole `<push-url>`; a changed target stops with `needs-input`.
2. Read the destination branch: `git ls-remote --exit-code <push-url> refs/heads/<branch>`.
   Exit 0 prints its commit, exit 2 means it does not exist there, and any other exit is unknown: stop.
3. The remote branch already at the shipped commit: the push is done. Record it and do not push again.
4. The remote branch at another commit: fetch it (`git fetch <push-url> refs/heads/<branch>`)
   where it is not local, then `git merge-base --is-ancestor <remote-commit> HEAD`. Exit 0 is a fast-forward.
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
   number,url,headRefName,headRefOid,headRepository,headRepositoryOwner,baseRefName`.
   Pass the branch name only:
   `--head <owner>:<branch>` is not accepted and returns `[]`, which reads as none.
2. Only exit 0 with `[]` means none (workflow step 9). Any other exit is unknown: stop.
3. Match `headRepository.nameWithOwner` to `<head-owner>/<head-repo>`, `headRepositoryOwner.login`
   to `<head-owner>` and `headRefName` to `<branch>`. A different repository, owner or branch is
   another head. More than one matching row is ambiguous: stop and list them rather than taking the first.
4. One match: skip creation and continue to step 7; never open a second.
5. None: repeat the lookup immediately before creation. A pull request that appeared since step 1
   takes the one-match path. Apply steps 2–3 again before any create.
6. Still none: write the body to a temporary file and use the same repository-ID mutation for a
   head in the base repository, a user-owned fork or an organization-owned fork:

   ```sh
   gh api graphql \
     -f query='mutation($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number url } } }' \
     -f 'input[repositoryId]=<base-id>' \
     -f 'input[headRepositoryId]=<head-id>' \
     -f 'input[baseRefName]=<base>' \
     -f 'input[headRefName]=<branch>' \
     -f 'input[title]=<title>' \
     -F 'input[body]=@<body-file>'
   ```

   Substitute the resolved values as literal arguments. The explicit `headRepositoryId` selects
   the head repository, so `headRefName` is the bare branch, never `owner:branch`.
   `-F` reads the body file; never use standard input. Require exit 0, no GraphQL errors and a
   non-null `data.createPullRequest.pullRequest`; otherwise stop with `failed` and reconcile on
   resume before another create. This avoids `gh pr create --head`'s organization-owner limit
   ([CLI manual](https://cli.github.com/manual/gh_pr_create),
   [API contract](https://docs.github.com/en/graphql/reference/pulls#createpullrequestinput)).
7. For every path — existing, discovered before creation or newly created — read back with the
   step 1 lookup. Require exit 0 and exactly one matching row; otherwise stop with `failed`.
   Its `baseRefName` must be the resolved base; a different base stops with `needs-input` rather
   than being edited. Its `headRefOid` must equal the shipped commit; a mismatch stops with `failed`.
8. After both comparisons pass, satisfy any required assignee. Read `gh pr view <number>
   -R <base-owner>/<repo> --json assignees`; unknown stops the run. If the required login is absent,
   add it with `gh pr edit <number> -R <base-owner>/<repo> --add-assignee <who>`, then read back with
   the same view command and require that login. This effect carries its own idempotency key and
   follows the same authority rule as creation. A failed assignment or missing read-back is
   `failed`; a resumed run uses this same step for the existing PR and does not create another.
   With no required assignee, skip assignment. Return only after these checks pass.

The ship record carries each effect's idempotency key and its read-backs. The push target identity
is the resolved head repository and branch; the PR target includes that head and the base repository
and branch. A resumed run re-derives the same keys. A head that already carries the commit is past
the commit, and the push and pull-request reconciles return an effect already made rather than repeating it.

## What it never does

It never merges, never deploys, never force-pushes, never rewrites history on the remote and never
pushes the base branch. It never skips a hook and never falls back from a gate that was chosen. Merge
authority stays with whoever holds it: standalone, the person.
