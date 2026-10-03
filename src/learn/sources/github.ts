/**
 * The review-source binding for GitHub: PR review threads, reviews and issue
 * comments through the `gh` CLI. `adapters/review-source/CONTRACT.md` is the
 * contract; this file is one binding of it.
 *
 * `gh` holds the credentials. This file never reads a token and never calls
 * the API directly; the runner is injectable so tests replay recorded shapes.
 */
import { run, type RunResult } from "../core/proc.ts";

export type GhRunner = (args: readonly string[], cwd: string) => RunResult;

export const ghRunner: GhRunner = (args, cwd) => run(["gh", ...args], { cwd, timeoutMs: 120_000 });

export interface GhUser {
  login: string;
  /** `Bot` for an app or automation account, whatever its login spells. */
  type?: string;
}

/** The author label of a comment: the login, marked `[bot]` when the host says the account is automation. */
export function authorLabel(user: GhUser | null): string {
  const login = user?.login ?? "";
  return user?.type === "Bot" && !login.endsWith("[bot]") ? `${login}[bot]` : login;
}

export interface PullRequestRef {
  number: number;
  headRefOid?: string;
  author?: GhUser | null;
}

/** `pulls/<n>/comments`: an inline review comment; `in_reply_to_id` marks a reply in its thread. */
export interface ReviewComment {
  id: number;
  in_reply_to_id?: number | null;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  created_at: string;
  user: GhUser | null;
  html_url: string;
  body: string | null;
}

/** `pulls/<n>/reviews`: a submitted review's summary body. */
export interface Review {
  body: string | null;
  html_url: string;
  submitted_at: string | null;
  user: GhUser | null;
}

/** `issues/<n>/comments`: a conversation comment on the PR. */
export interface IssueComment {
  body: string | null;
  html_url: string;
  created_at: string;
  user: GhUser | null;
}

/**
 * Split a stream of concatenated JSON values, which is what `gh api --paginate`
 * prints for array endpoints (`[...][...]`). String-aware, so a `][` inside a
 * comment body does not split a page.
 */
export function splitJsonValues(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return out;
}

/** Every page of a paginated array endpoint, flattened. Empty on any failure: a missing source is not an error. */
export function paginatedArray<T>(text: string): T[] {
  let values: unknown[];
  try {
    values = splitJsonValues(text);
  } catch {
    return [];
  }
  return values.flatMap((value) => (Array.isArray(value) ? (value as T[]) : []));
}

export class GitHubReviewSource {
  constructor(
    private readonly cwd: string,
    private readonly runner: GhRunner = ghRunner,
  ) {}

  private json<T>(args: readonly string[]): T | null {
    const result = this.runner(args, this.cwd);
    if (result.code !== 0) return null;
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      return null;
    }
  }

  private api<T>(path: string): T[] {
    const result = this.runner(["api", "--paginate", path], this.cwd);
    return result.code === 0 ? paginatedArray<T>(result.stdout) : [];
  }

  /** `owner/name` of the repository `gh` resolves from the working directory. */
  repo(): string | null {
    const result = this.runner(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], this.cwd);
    const name = result.stdout.trim();
    return result.code === 0 && name !== "" ? name : null;
  }

  /**
   * The PRs to ingest: the given numbers; else PRs updated on or after `since`
   * (`YYYY-MM-DD`); else the current branch's PR. Unknown numbers are skipped.
   */
  pullRequests(repo: string, numbers: readonly number[], since?: string): PullRequestRef[] {
    const fields = ["--json", "number,headRefOid,author"];
    if (numbers.length > 0) {
      return numbers.flatMap(
        (n) => this.json<PullRequestRef>(["pr", "view", String(n), "--repo", repo, ...fields]) ?? [],
      );
    }
    if (since !== undefined) {
      const listed = this.json<PullRequestRef[]>([
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--search",
        `updated:>=${since}`,
        "--limit",
        "100",
        ...fields,
      ]);
      return listed ?? [];
    }
    const current = this.json<PullRequestRef>(["pr", "view", ...fields]);
    return current === null ? [] : [current];
  }

  reviewComments(repo: string, pr: number): ReviewComment[] {
    return this.api<ReviewComment>(`repos/${repo}/pulls/${pr}/comments`);
  }

  reviews(repo: string, pr: number): Review[] {
    return this.api<Review>(`repos/${repo}/pulls/${pr}/reviews`);
  }

  issueComments(repo: string, pr: number): IssueComment[] {
    return this.api<IssueComment>(`repos/${repo}/issues/${pr}/comments`);
  }
}
