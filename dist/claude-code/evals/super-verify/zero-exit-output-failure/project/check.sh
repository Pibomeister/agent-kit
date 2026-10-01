#!/bin/sh
# The project's own check wrapper, written the way many repositories write it:
# the suite's output is teed to a log for CI artifacts. POSIX sh has no pipefail,
# so the pipeline's exit status is tee's, not the suite's.
bun test ./math.test.ts 2>&1 | tee check.log
