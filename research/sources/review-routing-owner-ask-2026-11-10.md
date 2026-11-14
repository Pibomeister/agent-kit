# Owner ask: review depth follows the delegation semaphore
The owner's words of 2026-11-10, about 17:25Z, captured verbatim.

> As we gear up to lean a lot more into formal verification and evidence production, we can lean
> less into reviews for giving us the ultimate call on whether something can be merged or not.
> Rather, reviews focus on:
> - whether we're not following patterns and conventions set up by the project
> - whether we're not following rules
> - whether we're likely introducing a bug
> - whether we created a new utility function instead of using one that was already present
> - that kind of thing, as well as correctness
>
> Reviews shouldn't be as in-depth as Agent Kit's review for all cases. The standard Agent Kit
> review with all the subagents that we spawn is super in-depth and super capable, but it also
> takes a long time and it burns a lot of tokens.
> We want to use our semaphore rule with red, yellow, and green determination based on the work in
> terms of complexity, damage potential, and touching files that impact functionality across a
> bunch of different features. That semaphore determines the level of scrutiny that we need:
> - Green uses a simple code review.
> - Yellow uses a multi-agent code review that perhaps doesn't enlist as many agents as we
>   currently do.
> - Red goes through the current review pipeline.
