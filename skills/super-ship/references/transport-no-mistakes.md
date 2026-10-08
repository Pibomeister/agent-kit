# Transport: no-mistakes delivery handoff

Loaded by `super-ship` for no-mistakes delivery. Ruling `no-mistakes-as-ship-transport` and
ADR-0012 govern this path. no-mistakes owns the branch after handoff, including its Review, checks,
fixes, rebases, push, pull request and CI.

## Handoff

Commit the change before verification and review-readiness. Record both at that committed handoff
head. Record ship-preflight at the same head with an empty working-tree diff. super-ship ends at
that record: it does not push or open a pull request and passes no `--skip`. No repository `auto_fix`
value is a precondition. The task's delivery contract starts no-mistakes after this handoff; the
pipeline runs unmodified and unskipped. Its Review may challenge a lifecycle-approved decision.

`--intent` carries only the captain's words. If those words expressly adopt source material by
reference, include the adopted substance in the captain's terms. Do not add a separate supervisor
decision, Firstmate's specification, the lifecycle plan or a worker summary. If no captain words
are available, stop for the supervisor rather than inventing intent.

## Pipeline gates and adoption

Answer a parked gate inside the pipeline under the task's delivery contract. An `ask-user` finding,
including one that challenges a lifecycle-approved decision, goes to the supervisor as an ordinary
needs-decision. The supervisor supplies the answer; the pipeline applies any fix. The worker does
not edit the branch while a pipeline run is active.

After checks pass, identify the pushed head and attribute every change from the handoff to
no-mistakes. Adopt its attributable changes and re-run verification at the pushed head without
repeating review. An `unreviewed` commit, a `missing` handoff commit, an overridden Review step or
an unattributable change escalates to the supervisor as needs-decision. Use the existing
`--run <run>` selector when naming a run on a replaced branch. ADR-0012 records the accepted
review gap for pipeline fixes and CI-monitor rebases.

The pipeline never grants merge authority. The supervisor's delivery contract owns the push, pull
request, CI result and any later merge decision.

## Deprecated legacy patched-binding path for delivery mode agent-kit

The patched Firstmate binding and its transport remain available for existing delivery mode
`agent-kit` installations. They are deprecated and are not the no-mistakes delivery default.
no-mistakes v1.79 refuses to push a run whose Review step was skipped.

### Deprecated skip transport

```
--skip review,document,rebase
```

The legacy transport skips Review because lifecycle review claimed the judgment, and skips
document and rebase because they can move the head after that judgment. A legacy push that cannot
carry those skips stops instead of silently changing its review contract.

### Deprecated auto-fix precondition

The legacy trusted no-mistakes config requires `auto_fix.test`, `auto_fix.lint` and `auto_fix.ci`
to be `0`. `checkNoMistakesConfig` and patched preflight enforce that legacy precondition; stock
preflight does not. A parked gate in this legacy path returns to lifecycle fix, verification and
delta review before another ship attempt. ADR-0002's “One owner per concern” decision describes
this superseded path.
