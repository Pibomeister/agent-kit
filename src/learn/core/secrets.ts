/**
 * The secret gate's pattern set: high-confidence credential formats and
 * absolute home-directory paths, each replaced by `[redacted:<kind>]`.
 *
 * Text the learning runtime records comes from sessions, observations, review
 * comments and judge replies, any of which can carry a pasted token. A ledger
 * is local, but its lessons are offered to the knowledgebase and its memory is
 * injected into later sessions, so a credential is removed before the text is
 * written rather than flagged after.
 *
 * Only formats a credential and nothing else takes are listed: a provider's
 * fixed prefix, a PEM private-key header, a JWT's two `eyJ` segments, or a
 * value in a position that only holds a credential (after `Bearer`, after
 * `Authorization: Basic`, as a URL's password). A generic high-entropy string
 * is never matched; the cost of a miss there is accepted over redacting
 * hashes, ids and commit shas. Documentation example values in a provider's
 * format are redacted like real ones, since the format is all the gate sees.
 *
 * A home path keeps everything after the user's directory, so
 * `/home/alice/src/app.ts` becomes `[redacted:home-path]/src/app.ts`: the
 * account name goes, the place in the project stays. A path counts only where
 * one can start (line start, whitespace, a quote or bracket, `=`, `:`, or
 * `file://`, or an escaped `\n`, `\r` or `\t`), so `/home/` inside a URL path
 * is left alone.
 *
 * The secret value is never reported, counted per kind only, and a scrubbed
 * text scrubs to itself.
 */

export const SECRET_KINDS = [
  "private-key",
  "aws-access-key",
  "aws-secret-key",
  "github-token",
  "gitlab-token",
  "slack-token",
  "slack-webhook",
  "anthropic-key",
  "openai-key",
  "stripe-key",
  "google-api-key",
  "npm-token",
  "jwt",
  "bearer-token",
  "basic-auth",
  "url-credentials",
  "home-path",
] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export type SecretCounts = Partial<Record<SecretKind, number>>;

interface SecretRule {
  kind: SecretKind;
  /** Global. The match is what gets replaced; context a rule keeps sits in a lookbehind. */
  pattern: RegExp;
}

/** End of a token: the next character cannot continue it. */
const END = String.raw`(?![A-Za-z0-9_-])`;
const PEM_LABEL = String.raw`(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?`;

/**
 * In order: a later rule never sees what an earlier one replaced, so a JWT
 * after `Bearer` is reported as a JWT.
 */
const RULES: readonly SecretRule[] = [
  {
    // A whole PEM block when its END line is present, else the header and the base64 body that follows it.
    kind: "private-key",
    pattern: new RegExp(
      String.raw`-----BEGIN ${PEM_LABEL}-----(?:[\s\S]*?-----END ${PEM_LABEL}-----|(?:[A-Za-z0-9+/=\r\n]|\\[rn])*)`,
      "g",
    ),
  },
  { kind: "aws-access-key", pattern: new RegExp(String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`, "g") },
  {
    kind: "aws-secret-key",
    pattern: new RegExp(
      String.raw`(?<=\baws_secret_access_key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])`,
      "gi",
    ),
  },
  {
    kind: "github-token",
    pattern: new RegExp(String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})${END}`, "g"),
  },
  { kind: "gitlab-token", pattern: new RegExp(String.raw`\bglpat-[A-Za-z0-9_-]{20,}${END}`, "g") },
  { kind: "slack-token", pattern: new RegExp(String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}${END}`, "g") },
  {
    kind: "slack-webhook",
    pattern: new RegExp(String.raw`https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+`, "g"),
  },
  { kind: "anthropic-key", pattern: new RegExp(String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}${END}`, "g") },
  { kind: "openai-key", pattern: new RegExp(String.raw`\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}${END}`, "g") },
  { kind: "stripe-key", pattern: new RegExp(String.raw`\b(?:sk|rk)_live_[A-Za-z0-9]{16,}${END}`, "g") },
  { kind: "google-api-key", pattern: new RegExp(String.raw`\bAIza[A-Za-z0-9_-]{35}${END}`, "g") },
  { kind: "npm-token", pattern: new RegExp(String.raw`\bnpm_[A-Za-z0-9]{36}${END}`, "g") },
  {
    kind: "jwt",
    pattern: new RegExp(String.raw`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, "g"),
  },
  {
    // 20+ token characters with at least one digit, so prose after the word "Bearer" survives.
    kind: "bearer-token",
    pattern: new RegExp(String.raw`(?<=\bBearer\s+)(?=[A-Za-z0-9._~+/-]*[0-9])[A-Za-z0-9._~+/-]{20,}=*`, "gi"),
  },
  {
    kind: "basic-auth",
    pattern: new RegExp(String.raw`(?<=\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)[A-Za-z0-9+/]{8,}={0,2}`, "gi"),
  },
  {
    // `scheme://user:password@`; a password that is a `$VAR`, `${VAR}`, `%VAR%` or `<name>` reference is left alone.
    kind: "url-credentials",
    pattern: new RegExp(
      String.raw`(?<=\b[A-Za-z][A-Za-z0-9+.-]*://)[^\s/?#@:"'<>]+:(?![$%{<])[^\s/?#@"'<>]+(?=@)`,
      "g",
    ),
  },
  {
    kind: "home-path",
    pattern: new RegExp(
      String.raw`(?<=^|[\s"'\x60(\[{<=,;:|>]|file://|\\[nrt])` +
        String.raw`(?:/(?:var/)?home/[A-Za-z0-9._-]+|/Users/(?!Shared(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+|/root)` +
        String.raw`(?![A-Za-z0-9._-])`,
      "gm",
    ),
  },
];

export const redactionMarker = (kind: SecretKind): string => `[redacted:${kind}]`;

export interface Scrubbed {
  text: string;
  found: SecretCounts;
}

/** `text` with every match replaced by its kind's marker, and how many of each kind were replaced. */
export function scrubSecrets(text: string): Scrubbed {
  const found: SecretCounts = {};
  let out = text;
  for (const { kind, pattern } of RULES) {
    out = out.replace(pattern, () => {
      found[kind] = (found[kind] ?? 0) + 1;
      return redactionMarker(kind);
    });
  }
  return { text: out, found };
}

/** Sum of the counts in `b` into `a`. */
export function addCounts(a: SecretCounts, b: SecretCounts): SecretCounts {
  for (const kind of SECRET_KINDS) if (b[kind] !== undefined) a[kind] = (a[kind] ?? 0) + b[kind];
  return a;
}

/** A JSON string literal: the only place serialized JSON holds text. */
const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;

/**
 * `scrubSecrets` over each string literal of serialized JSON, keys included, so
 * a match never spans two values and the result is still JSON. The literal is
 * scrubbed in its escaped form: no rule's match starts or ends inside an
 * escape, and an escaped line break counts as one before a home path.
 */
export function scrubJsonText(json: string): Scrubbed {
  const found: SecretCounts = {};
  const text = json.replace(JSON_STRING, (literal) => {
    const inner = scrubSecrets(literal.slice(1, -1));
    addCounts(found, inner.found);
    return `"${inner.text}"`;
  });
  return { text, found };
}
