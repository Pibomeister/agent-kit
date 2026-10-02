/**
 * Just enough shell parsing to see which files a command reads, for hosts whose only way to load
 * a skill is to read its SKILL.md through a shell, plus the read-only program, git and gh tables
 * the scorer and the Grok permission rules share. Pure. Not a test file.
 */

/** `/bin/zsh -lc '…'` and friends: the command a host wrapped in a login shell. */
const WRAPPED = /^\s*(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/;

/** Split into words, honouring single and double quotes and backslashes; operators become their own words. */
export function words(command: string): string[] {
  const out: string[] = [];
  let word = "";
  let started = false;
  const push = () => {
    if (started) out.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end < 0 ? undefined : end);
      started = true;
      i = end < 0 ? command.length : end;
    } else if (ch === '"') {
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) i++;
        word += command[i];
        i++;
      }
      started = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      word += command[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      push();
    } else if (ch === ">" || ch === "<") {
      // A redirect is its own word (`a.md>x`, `status>&1`). It stays attached to an fd (`2>`),
      // to `&` (`&>file`), while `>>` is still growing (`>>`, `2>>`, `&>>`), or while `<>`
      // is still growing (`<>file`, `0<>file`). That open creates the file.
      const rwOpen = ch === ">" && /^(?:\d+)?<$/.test(word);
      const stays = /^\d+$/.test(word) || word === "&" || (ch === ">" && /^(?:\d+|&)?>$/.test(word)) || rwOpen;
      if (word !== "" && !stays) push();
      word += ch;
      started = true;
    } else if (ch === "&" && (/^\d*>$/.test(word) || command[i + 1] === ">")) {
      if (!/^\d*>$/.test(word)) push();
      word += ch;
      started = true;
    } else if (";|&".includes(ch)) {
      push();
      const op = command[i + 1] === ch ? ch + ch : ch;
      out.push(op);
      i += op.length - 1;
    } else {
      word += ch;
      started = true;
    }
  }
  push();
  return out;
}

/** The command a login-shell wrapper runs, or the command itself. */
export function unwrap(command: string): string {
  const m = WRAPPED.exec(command);
  if (m === null) return command;
  const inner = words(m[1]!);
  return inner.length === 1 ? inner[0]! : command;
}

const PLAIN_ASSIGNMENT = /^[A-Za-z_]\w*=[\s\S]*$/;
const ASSIGNMENT_EXECUTION = /`|\$\(|[<>]\(/;

/** A standalone assignment changes only the current shell and runs no nested command. */
export function plainAssignmentSegment(segment: readonly string[]): boolean {
  return segment.length > 0 && segment.every((word) => PLAIN_ASSIGNMENT.test(word) && !ASSIGNMENT_EXECUTION.test(word));
}

/** Programs the scorer accepts as read-only for all arguments not rejected by its write-flag guard. */
export const READ_ONLY_PROGRAMS = [
  "cd",
  "pushd",
  "popd",
  "ls",
  "cat",
  "bat",
  "nl",
  "less",
  "more",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "pwd",
  "echo",
  "awk",
  "tree",
  "stat",
  "file",
  "which",
  "type",
  "true",
  "cut",
  "realpath",
  "lsof",
  "[",
  "test",
] as const;

/** Git subcommands the scorer accepts as read-only after global options. */
export const READ_ONLY_GIT = [
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "blame",
  "shortlog",
  "describe",
  "cat-file",
  "grep",
  "merge-base",
  "rev-list",
  "for-each-ref",
  "show-ref",
  "count-objects",
] as const;

/** Git subcommands the scorer accepts only for these first non-option actions. */
export const READ_ONLY_GIT_ACTIONS = {
  stash: ["list", "show"],
  remote: ["", "show", "get-url"],
  worktree: ["list"],
  notes: ["list"],
} as const;

/** gh group/action pairs the scorer accepts as read-only. `api` has flag-sensitive handling. */
export const READ_ONLY_GH_ACTIONS = {
  auth: ["status"],
  repo: ["view"],
  pr: ["view", "list", "checks", "diff", "status"],
  issue: ["view", "list", "checks", "diff", "status"],
  run: ["view", "list", "checks", "diff", "status"],
} as const;

const bashRules = (prefix: string): string[] => [`Bash(${prefix})`, `Bash(${prefix} *)`];

/**
 * Grok permission rules generated from the scorer's read-only tables. The host matches shell
 * segments by glob, so commands whose safe subset needs semantic parsing stay out: awk programs,
 * sed scripts, curl flags, gh api flags, shell loops, arbitrary help/version calls, the ship
 * gate's `check` behind a path, git options that take a value before the subcommand, and harmless
 * output redirections that the same glob used to deny writes would also match. `git branch`,
 * `git tag` and `sort` are exact forms, because a trailing glob would also admit a ref-writing
 * flag, a name to create, or a bundled `-o`. The direct `printenv` and `gh auth status
 * --show-token` forms are looks to the scorer and have no rule here. Variable expansion and command
 * substitution through an admitted program such as `echo` or `test` remain admitted and scored
 * read-only, but only the process basics, the adapter-declared variables and the names the
 * operator opted in are present in the subject's environment.
 * No rule covers a plain assignment whose variable a later `find` reads: the Grok 1.0.46 user guide
 * (`22-permissions-and-safety.md`, Rule Matching Reference) honours an allow rule for a variable
 * argument only as an `ls` or `rg` file operand, and other programs still prompt. The eval's
 * `PreToolUse` hook (`grok-mediator.ts`) rewrites such a chain into literal commands and checks
 * each against these same rules.
 * `dontAsk` leaves the rest visible as cancelled invalid sessions. Denies guard the write-shaped
 * forms of broad safe-prefix rules; deny wins over allow in Grok's grammar. The redirect deny
 * refuses every segment containing `>`, which no rule did before it.
 */
export function grokReadOnlyPermissionRules() {
  const grammarGaps = new Set(["awk", "["]);
  const allow = READ_ONLY_PROGRAMS.filter((program) => !grammarGaps.has(program)).flatMap(bashRules);
  allow.push("Bash(command -v *)", "Bash(command -V *)");
  allow.push(...["", " -u", " -r", " -n", " -rn", " -nr"].map((flags) => `Bash(sort${flags})`));
  const git = READ_ONLY_GIT.flatMap((subcommand): string[] => [subcommand, `${subcommand} *`]);
  for (const [subcommand, actions] of Object.entries(READ_ONLY_GIT_ACTIONS)) {
    for (const action of actions)
      git.push(
        ...(action === ""
          ? [subcommand, `${subcommand} -v`]
          : [`${subcommand} ${action}`, `${subcommand} ${action} *`]),
      );
  }
  git.push(
    "reflog",
    "reflog show",
    "reflog show *",
    "config --get *",
    "config --get-all *",
    "config --get-regexp *",
    "config --list*",
    "config -l*",
    "branch",
    "branch -a",
    "branch -r",
    "branch -v",
    "branch -vv",
    "branch -avv",
    "branch --all",
    "branch --list",
    "branch --show-current",
    "tag",
    "tag -l",
    "tag --list",
  );
  for (const prefix of ["git", "git --no-pager"]) allow.push(...git.map((rest) => `Bash(${prefix} ${rest})`));
  for (const [group, actions] of Object.entries(READ_ONLY_GH_ACTIONS)) {
    for (const action of actions)
      allow.push(...(group === "auth" ? [`Bash(gh ${group} ${action})`] : bashRules(`gh ${group} ${action}`)));
  }
  allow.push(
    "Bash(ak learn review report)",
    "Bash(ak learn memory show)",
    ...bashRules("bun run ak validate"),
    ...bashRules("bun run ak status"),
  );

  const deny = [
    "Bash(*>*)",
    "Bash(find *-delete*)",
    "Bash(find *-exec*)",
    "Bash(find *-ok*)",
    "Bash(find *-fprint*)",
    "Bash(find *-fls*)",
    "Bash(rg *--pre *)",
    "Bash(rg *--pre=*)",
    "Bash(git *--output*)",
  ];
  return { allow: [...new Set(allow)], deny };
}

/** Programs that print a file, and the options of each that take a value. */
const READERS: Record<string, ReadonlySet<string>> = {
  cat: new Set(),
  bat: new Set(["-r", "--line-range", "-l", "--language"]),
  head: new Set(["-n", "-c"]),
  tail: new Set(["-n", "-c"]),
  nl: new Set(["-b", "-w", "-s"]),
  less: new Set(),
  more: new Set(),
  sed: new Set(["-e", "-f"]),
};

const OPERATORS = new Set([";", "|", "||", "&", "&&"]);

/** Files a shell command prints, stdin redirects included. `sed`'s first operand is its script unless `-e` or `-f` gave one. */
export function readsOf(command: string): string[] {
  const all = words(unwrap(command));
  const files: string[] = [];
  let segment: string[] = [];
  const flush = () => {
    const [program, ...args] = segment;
    segment = [];
    const takesValue = program === undefined ? undefined : READERS[program.split("/").at(-1)!];
    if (takesValue === undefined) return;
    const operands: string[] = [];
    let scriptGiven = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      const redirect = /^(\d*|&)(<>|>>?|<)(&?)(.*)$/.exec(arg);
      if (redirect !== null) {
        const target = redirect[4] !== "" ? redirect[4]! : args[++i];
        // `<` reads the target. `<>` opens it read-write, which reads it and creates it when missing.
        if ((redirect[2] === "<" || redirect[2] === "<>") && target !== undefined) operands.push(target);
        continue;
      }
      if (arg.startsWith("-") && arg !== "-") {
        if (takesValue.has(arg)) {
          if (arg === "-e" || arg === "-f") scriptGiven = true;
          i++;
        }
        continue;
      }
      operands.push(arg);
    }
    const isSed = program!.endsWith("sed");
    files.push(...(isSed && !scriptGiven ? operands.slice(1) : operands).filter((f) => f !== "-"));
  };
  for (const w of all) {
    if (OPERATORS.has(w)) flush();
    else segment.push(w);
  }
  flush();
  return files;
}
