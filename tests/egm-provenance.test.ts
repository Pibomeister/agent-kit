/**
 * FILE_HASHES pin provenance-only files by sha256 of the raw bytes (any
 * dossier edit needs a re-pin). BLOCK_PINS hash mixed-file marker interiors
 * after CRLF folds to LF; begin and end must appear once as exact bytes on
 * unmasked and fence-masked text. LOCK_ENTRY_SHA256 is the lock egm entry,
 * an identity-covered region. FINGERPRINT_DESC_SHA256 pins the fingerprint
 * description. OVERLAY_COPIES must equal source bytes. IDENTITY_ALLOWLIST
 * is the only other place identity tokens may appear. Tokens
 * (elephant-goldfish, a ≥7-char prefix of the pin SHA, GAP-PROBE,
 * GAP-MASTRA, the word EGM) match after NFKD, stripping marks, format,
 * Default_Ignorable, and other controls (\p{M}, \p{Cf},
 * \p{Default_Ignorable_Code_Point}, \p{Cc}), then case-fold. Files decode
 * as UTF-8, fatal; a decode failure is red unless the path is in
 * BINARY_ALLOWLIST, which must be empty. A hex run is identity when the
 * pin's 7-character prefix appears anywhere inside it. Hex split across
 * non-hex characters is out of scope. The word EGM skips only one
 * exact-byte BLOCK_PINS marker pair in that pin's file. Lookalike or
 * case-changed markers are plain text. Small-caps ᴇɢᴍ does not NFKD-fold
 * and is out of scope. A free-text claim with no identity token is
 * review's job. Every SENTENCE_PINS and BLOCK_PINS pin occurs exactly
 * once in exact bytes in its file. package.json has one "description"
 * key whose parsed value equals the pin. The isolation-review-context
 * table row occurs once after whitespace fold and lies inside the
 * adapters/cursor/CONTRACT.md hashed interior.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse, stringify } from "yaml";

import { loadCatalog } from "../src/catalog/load.ts";
import { DENY_TERMS, matchTerms } from "../src/denylist.ts";
import {
  checkAdaptationsSync,
  loadAdaptationFragments,
  loadDonors,
  parseDonorSource,
} from "../src/validation/provenance.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const REPO = resolve(import.meta.dir, "..");
const EGM_COMMIT = "403d8881d62022490637d740657b33f01e321ea8";
const EGM_COMMIT_DATE = "2026-10-30T08:43:28Z";
const EGM_COPYRIGHT = "Copyright 2026 Google LLC";
const EGM_LICENSE_FILE = "provenance/licenses/google_elephant-goldfish-model.LICENSE";
const EGM_REPO = "google/elephant-goldfish-model";
const EGM_URL = "https://github.com/google/elephant-goldfish-model";
const EGM_PATH = ".donors/google_elephant-goldfish-model";
const LOCK = "provenance/upstream.lock.yaml";
const GAP_PROBE = "research/host-facts/2026-11-18/GAP-PROBE.md";
const MIT_CATALOG_IDS = [
  "compound-engineering",
  "superpowers",
  "pocock",
  "addy",
  "omc",
  "omx",
  "builderio-skills",
  "pstack",
  "claude-reflect",
  "common-skills",
] as const;
const CATALOG_PREFIXES = [
  "skills/",
  "roles/",
  "packs/",
  "protocols/",
  "references/",
  "policies/",
  "adapters/",
] as const;

const FILE_HASHES: Array<{ file: string; sha256: string }> = [
  { file: "NOTICE", sha256: "4e3959890e74c13743d11acd92fa4bf9fa2fcde378896d4f042e2e48a0f64f19" },
  { file: GAP_PROBE, sha256: "73f79b67e12b388b09b482959faaf83c4370f664d6476f4eec321cd830e322ca" },
  {
    file: "research/dossiers/egm.md",
    sha256: "e5ce066c6f656e2d34ebd4c13caa36eda2de7282fe65483253b33a62bfad833e",
  },
  {
    file: "provenance/adaptations.d/comprehension-seat.yaml",
    sha256: "478be32d48f0c566370b3f8af8d6f196330e6811e3b615aa0c7abd1b8a1608f0",
  },
  {
    file: "provenance/donor-snapshots/egm@403d8881d620/agents/codebase_details.md",
    sha256: "d80db07e449b57b3b3776d1401cca72a54b6b65a0ab218b86f9064ee4b8167bc",
  },
  {
    file: "provenance/donor-snapshots/egm@403d8881d620/agents/comprehension.md",
    sha256: "974f4972f717dc7b102a9b1407b3a625749149f2ae905727241e919f43cc3fa5",
  },
  {
    file: "provenance/donor-snapshots/egm@403d8881d620/resources/document_standards/implementation-readiness-standard.md",
    sha256: "ed0d2a085eac0fd9581d504a2ec0df2a92d6b2538636a22b16e0b1370fba6dbb",
  },
  {
    file: "provenance/donor-snapshots/egm@403d8881d620/skills/egm-resolve/SKILL.md",
    sha256: "6bb1909b42b815e074bd486c6244b56eef8d61669abb3302c764a16be05af472",
  },
  {
    file: "provenance/donor-snapshots/egm@403d8881d620/tests/integration/test_claude.py",
    sha256: "5af7ebd89b8fa7419b23ec006f291c02855bfc3b8e76df175cdec2105bfc37be",
  },
  {
    file: "provenance/donor-snapshots/egm@403d8881d620/tests/integration/test_codex.py",
    sha256: "684f722839ec7e5520b6923da606a62d5719b4d1f08944368c52121b706f7cc7",
  },
];

const IDENTITY_ALLOWLIST: Array<{ file: string; reason: string }> = [
  { file: "tests/egm-provenance.test.ts", reason: "the pin test names the identity strings it scans" },
  {
    file: ".cursor/bin/ak.js",
    reason: "generated; packaging inlines NOTICE and cursor-packaging checks the file",
  },
  { file: ".cursor/bin/ak-gate.mjs", reason: "generated; packaging inlines NOTICE" },
  {
    file: "provenance/adaptations.yaml",
    reason: "generated from fragments; checkAdaptationsSync is the pin",
  },
];

const FOLDED_NEEDLES = ["elephant-goldfish", "gap-probe", "gap-mastra"] as const;
const EGM_PIN7 = EGM_COMMIT.slice(0, 7);
const BINARY_ALLOWLIST: string[] = [];
const PACKAGE_DESCRIPTION =
  "One engineering lifecycle amalgamated from twelve donors (ten MIT, two Apache-2.0): seven super skills, packs, protocols and roles, installable as a Claude Code plugin under /ak:.";
type SentencePin = { file: string; text: string; jsonKey?: string };
const SENTENCE_PINS: SentencePin[] = [
  {
    file: "README.md",
    text: "One engineering lifecycle, amalgamated from twelve donors (ten MIT-licensed, two Apache-2.0) into a single installable",
  },
  {
    file: "package.json",
    text: `"description": "${PACKAGE_DESCRIPTION}",`,
    jsonKey: "description",
  },
  {
    file: ".claude-plugin/marketplace.json",
    text: '"description": "One engineering lifecycle amalgamated from twelve donors (ten MIT, two Apache-2.0), installable under /ak:."',
  },
];
const OVERLONG_UTF8 = new Uint8Array([0xc0, 0x80]);

const LOCK_ENTRY_SHA256 = "1f48385ba3ca27a065fa1448af81d6b8aa5cd05dc545d3d76ab605fbbd03da77";
const FINGERPRINT_DESC_SHA256 = "7df2fe33f96517c13e3756bdb727912f1f9d7a1a8bc61fdcda8fdb7f737581ff";

type BlockPin = { file: string; begin: string; end: string; sha256: string };

const BLOCK_PINS: BlockPin[] = [
  {
    file: "README.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "088c4feef4d2b12e01ffdf6c0c528768ac4b3a549945f80009370527e2bc496d",
  },
  {
    file: "adapters/claude-code/CONTRACT.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "0387535cb2bf969fa90bc7f41ce1f1921e3bd31d120342d27bc2fa956c54c0d8",
  },
  {
    file: "src/review-isolation-probe/hosts.ts",
    begin: " * ak-egm-begin",
    end: " * ak-egm-end",
    sha256: "08e49b8642e290b9c010414ad3bbaa068c8b34d97a9d83b984cae47f0a069d3c",
  },
  {
    file: "roles/doc-review/comprehension/ROLE.md",
    begin: "<!-- ak-egm-naive-begin -->",
    end: "<!-- ak-egm-naive-end -->",
    sha256: "921984a62fe92132260413270795f7124105dc0426268305461aa95343fcdba6",
  },
  {
    file: "policies/resolved-conflicts.yaml",
    begin: "# ak-egm-begin",
    end: "# ak-egm-end",
    sha256: "4e80885494d7da2683f47f94b4ff4451d71c3097205cddb19e897886d87f19d0",
  },
  {
    file: ".cursor/references/shared/adapters/claude-code/CONTRACT.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "0387535cb2bf969fa90bc7f41ce1f1921e3bd31d120342d27bc2fa956c54c0d8",
  },
  {
    file: ".cursor/references/shared/roles/doc-review/comprehension/ROLE.md",
    begin: "<!-- ak-egm-naive-begin -->",
    end: "<!-- ak-egm-naive-end -->",
    sha256: "921984a62fe92132260413270795f7124105dc0426268305461aa95343fcdba6",
  },
  {
    file: "AGENTS.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "35b5f6a2c01807115b147a8ce1e0a53a925830d9dd77aa51d269be23a6adc433",
  },
  {
    file: "src/review-isolation-probe/children.ts",
    begin: " * ak-egm-begin",
    end: " * ak-egm-end",
    sha256: "c01c584069b6998d1e2639817457603c955d9ee17b11f4a6332f8c794ba9cdee",
  },
  {
    file: "adapters/cursor/CONTRACT.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "b2046e7fbb9fc4d6f4617bc9afff4d15aa9670ccee694c2a230faaf9a9657641",
  },
  {
    file: "skills/doc-review/SKILL.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "696149bfb2ff403d89dab493f88243c4b65484cf557dbac3b6d7622e83b20147",
  },
  {
    file: ".cursor/skills/doc-review/SKILL.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "12da903a48f66a6cdb23f23f1b4d4c092ea7719a726e40ca30f12a2b3f4bfc88",
  },
  {
    file: ".cursor/agents/doc-review-comprehension.md",
    begin: "<!-- ak-egm-naive-begin -->",
    end: "<!-- ak-egm-naive-end -->",
    sha256: "921984a62fe92132260413270795f7124105dc0426268305461aa95343fcdba6",
  },
  {
    file: "tests/egm-review-schemas.test.ts",
    begin: " * ak-egm-begin",
    end: " * ak-egm-end",
    sha256: "04a16c8b254836a5241af8110fc8a36f04187c10567dc834dc22f1cd825463a6",
  },
  {
    file: "tests/egm-review-schemas.test.ts",
    begin: "  // ak-egm-begin-compile",
    end: "  // ak-egm-end-compile",
    sha256: "c422ebe978c232dfa3b3647ec3b3740e878aa21bbbe669e0f00368c550607b5e",
  },
  {
    file: "tests/egm-gap-status.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "e2c87d64a63e471355b6c6ebd00c4479c5479184a48acd54c5baf167859b914c",
  },
  {
    file: "tests/packaging.test.ts",
    begin: "/* ak-egm-begin */",
    end: "/* ak-egm-end */",
    sha256: "5c9cff071423f4905ff0647550ea3bccaaab4e36bd31051923ffffa09d99f6ae",
  },
  {
    file: "provenance/adaptations.d/define.yaml",
    begin: "# ak-egm-begin-bound",
    end: "# ak-egm-end-bound",
    sha256: "0af6dbffaa991ac58fb6b2118a7b6cb1383b71bcc476c00c57fafd5173da79a1",
  },
  {
    file: "provenance/adaptations.d/define.yaml",
    begin: "# ak-egm-begin-doc-review",
    end: "# ak-egm-end-doc-review",
    sha256: "f959332f7e254ed167023c477b617fb5384332c1ba92a5144a371ce7ca9f73b9",
  },
  {
    file: "provenance/adaptations.d/review-isolation-probe.yaml",
    begin: "# ak-egm-begin",
    end: "# ak-egm-end",
    sha256: "eb01c0b1acd1935d1fb569117b898c5ab16caca0a141f59d63f03657447e6c63",
  },
  {
    file: "provenance/adaptations.d/review-routing.yaml",
    begin: "# ak-egm-begin",
    end: "# ak-egm-end",
    sha256: "6ae0493bfa7407b9e59c877dedfdfb7a1122bfc35d944656b2f2b971eb2431ae",
  },
  {
    file: "skills/doc-review/skill.yaml",
    begin: "# ak-egm-begin",
    end: "# ak-egm-end",
    sha256: "782366d688fc022aa16901bf084c3b509480cd0dae69c750ace79012dbd762ea",
  },
  {
    file: "skills/super-bound/skill.yaml",
    begin: "# ak-egm-begin",
    end: "# ak-egm-end",
    sha256: "eeb2cdbba8509f480ac88607cbf87c08ce0e9bfc43e6bb1f896655ae1b8cf71c",
  },
];

const OVERLAY_COPIES: Array<{ src: string; dest: string }> = [
  { src: "NOTICE", dest: ".cursor/licenses/NOTICE" },
  {
    src: "roles/doc-review/comprehension/ROLE.md",
    dest: ".cursor/roles/doc-review/comprehension/ROLE.md",
  },
  { src: "schemas/finding.schema.json", dest: ".cursor/schemas/finding.schema.json" },
  {
    src: "schemas/finding.schema.json",
    dest: ".cursor/references/shared/schemas/finding.schema.json",
  },
];

function catalogDonorLicenses(root: string): Map<string, string> {
  const { donors } = loadDonors(root);
  const { rows } = loadAdaptationFragments(root);
  const catalog = new Map<string, string>();
  for (const row of rows) {
    const src = parseDonorSource(row.source);
    if (src === null) continue;
    if (!CATALOG_PREFIXES.some((prefix) => row.path.startsWith(prefix))) continue;
    const donor = donors.get(src.donor);
    if (donor === undefined || donor.license === "") continue;
    catalog.set(src.donor, donor.license);
  }
  return catalog;
}

function expectTwelveCatalogDonors(catalog: Map<string, string>): void {
  const apache: string[] = [];
  const mit: string[] = [];
  for (const [id, license] of catalog) {
    if (license === "Apache-2.0") apache.push(id);
    else if (license === "MIT") mit.push(id);
  }
  expect(catalog.size).toBe(12);
  expect(mit.toSorted()).toEqual([...MIT_CATALOG_IDS].toSorted());
  expect(apache.toSorted()).toEqual(["claude-mem", "egm"]);
}

function countWord(n: number): string {
  if (n === 2) return "two";
  if (n === 10) return "ten";
  if (n === 12) return "twelve";
  expect(n, `count-word ${n}`).toBe(12);
  return "twelve";
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface LockDonor {
  id: string;
  commit: string;
  commit_date: string;
  license: string;
  copyright: string;
  license_file: string;
  path: string;
  url: string;
  repo: string;
}

interface LockDoc {
  donors: unknown[];
}

interface LooseDonor {
  id: string;
  commit?: unknown;
  commit_date?: unknown;
  license?: unknown;
  copyright?: unknown;
  license_file?: unknown;
  path?: unknown;
  url?: unknown;
  repo?: unknown;
}

const isLockDoc = new Ajv2020({ strict: false }).compile<LockDoc>({
  type: "object",
  required: ["donors"],
  properties: { donors: { type: "array" } },
});

const isLooseDonor = new Ajv2020({ strict: false }).compile<LooseDonor>({
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
  additionalProperties: true,
});

const isPluginExample = new Ajv2020({ strict: false }).compile<{ description: string }>({
  type: "object",
  required: ["description"],
  properties: { description: { type: "string" } },
});

const isFingerprintSchema = new Ajv2020({ strict: false }).compile<{
  properties: { fingerprint: { description: string } };
}>({
  type: "object",
  required: ["properties"],
  properties: {
    properties: {
      type: "object",
      required: ["fingerprint"],
      properties: {
        fingerprint: {
          type: "object",
          required: ["description"],
          properties: { description: { type: "string" } },
        },
      },
    },
  },
});

const isLockDonor = new Ajv2020({ strict: false }).compile<LockDonor>({
  type: "object",
  required: ["id", "commit", "commit_date", "license", "copyright", "license_file", "path", "url", "repo"],
  properties: {
    id: { type: "string" },
    commit: { type: "string" },
    commit_date: { type: "string" },
    license: { type: "string" },
    copyright: { type: "string" },
    license_file: { type: "string" },
    path: { type: "string" },
    url: { type: "string" },
    repo: { type: "string" },
  },
});

function loadLockDonors(root: string, version?: "1.1"): Map<string, LockDonor> {
  const text = readFileSync(join(root, LOCK), "utf8");
  const value: unknown = version === "1.1" ? parse(text, { version: "1.1" }) : parse(text);
  expect(isLockDoc(value), "lock donors").toBe(true);
  if (!isLockDoc(value)) return new Map();
  const ids: string[] = [];
  const out = new Map<string, LockDonor>();
  for (const entry of value.donors) {
    if (!isLooseDonor(entry)) continue;
    ids.push(entry.id);
    let commitDate = entry.commit_date;
    if (commitDate instanceof Date && !Number.isNaN(commitDate.getTime())) {
      commitDate = commitDate.toISOString().replace(".000Z", "Z");
    }
    const built = {
      id: entry.id,
      commit: entry.commit,
      commit_date: commitDate,
      license: entry.license,
      copyright: entry.copyright,
      license_file: entry.license_file,
      path: entry.path,
      url: entry.url,
      repo: entry.repo,
    };
    if (!isLockDonor(built)) continue;
    out.set(built.id, built);
  }
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  expect(duplicates, `duplicate donor ids=${duplicates.join(",")}`).toEqual([]);
  return out;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function textSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function maskFences(text: string): string {
  const lines = text.split("\n");
  let fence = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      fence = !fence;
      out.push(" ".repeat(line.length));
      continue;
    }
    out.push(fence ? " ".repeat(line.length) : line);
  }
  return out.join("\n");
}

function indicesOf(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    hits.push(at);
    from = at + needle.length;
  }
  return hits;
}

function extractPinnedBlock(text: string, pin: BlockPin): string {
  const folded = text.replaceAll("\r\n", "\n");
  const visible = maskFences(folded);
  const begins = indicesOf(visible, pin.begin);
  const ends = indicesOf(visible, pin.end);
  const unmaskedBegins = indicesOf(folded, pin.begin);
  const unmaskedEnds = indicesOf(folded, pin.end);
  expect(unmaskedBegins.length, `${pin.file} unmasked begin matches=${unmaskedBegins.length}`).toBe(1);
  expect(unmaskedEnds.length, `${pin.file} unmasked end matches=${unmaskedEnds.length}`).toBe(1);
  expect(begins.length, `${pin.file} begin matches=${begins.length}`).toBe(1);
  expect(ends.length, `${pin.file} end matches=${ends.length}`).toBe(1);
  const start = (begins[0] ?? 0) + pin.begin.length;
  const stop = ends[0] ?? 0;
  expect(start <= stop, `${pin.file} inverted markers`).toBe(true);
  return folded.slice(start, stop);
}

function foldIdentity(text: string): string {
  return text
    .normalize("NFKD")
    .replaceAll(/\p{M}|\p{Cf}|\p{Default_Ignorable_Code_Point}|\p{Cc}/gu, "")
    .toLowerCase();
}

function foldOffset(original: string, at: number): number {
  return foldIdentity(original.slice(0, at)).length;
}

function decodeTracked(file: string, bytes: Uint8Array): string {
  if (BINARY_ALLOWLIST.includes(file)) return "";
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n");
}

function readTracked(file: string): string {
  return decodeTracked(file, readFileSync(join(REPO, file)));
}

function skipTrackedPath(raw: string): boolean {
  return raw.split("/").includes("node_modules");
}

function trackedTextFiles(): string[] {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "buffer" });
  expect(listed.status, "git ls-files").toBe(0);
  const files: string[] = [];
  for (const raw of listed.stdout.toString("utf8").split("\0")) {
    if (raw === "" || skipTrackedPath(raw)) continue;
    files.push(raw);
  }
  return files;
}

function exactMarkerRanges(file: string, original: string) {
  const skip: Array<[number, number]> = [];
  const cover: Array<[number, number]> = [];
  for (const pin of BLOCK_PINS.filter((row) => row.file === file)) {
    const begins = indicesOf(original, pin.begin);
    const ends = indicesOf(original, pin.end);
    const beginAt = begins[0];
    const endAt = ends[0];
    if (beginAt === undefined || endAt === undefined || begins.length !== 1 || ends.length !== 1) continue;
    skip.push([foldOffset(original, beginAt), foldOffset(original, beginAt + pin.begin.length)]);
    skip.push([foldOffset(original, endAt), foldOffset(original, endAt + pin.end.length)]);
    cover.push([foldOffset(original, beginAt + pin.begin.length), foldOffset(original, endAt)]);
  }
  return { skip, cover };
}

function identityOffsets(file: string, original: string): number[] {
  const folded = foldIdentity(original);
  const skip = exactMarkerRanges(file, original).skip;
  const hits: number[] = [];
  for (const needle of FOLDED_NEEDLES) hits.push(...indicesOf(folded, needle));
  for (const match of folded.matchAll(/[0-9a-f]{7,}/g)) {
    if (match[0].includes(EGM_PIN7)) hits.push(match.index ?? 0);
  }
  for (const match of folded.matchAll(/(?<![a-z0-9_])egm(?![a-z0-9_])/g)) {
    const at = match.index ?? 0;
    if (offsetCovered(at, skip)) continue;
    hits.push(at);
  }
  return hits;
}

function coveredRanges(file: string, original: string): Array<[number, number]> {
  const foldedLen = foldIdentity(original).length;
  if (FILE_HASHES.some((pin) => pin.file === file)) return [[0, foldedLen]];
  if (OVERLAY_COPIES.some((copy) => copy.dest === file)) return [[0, foldedLen]];
  if (IDENTITY_ALLOWLIST.some((entry) => entry.file === file)) return [[0, foldedLen]];
  if (file === LOCK) {
    const startNeedle = "  # Catalog donor, no EGM plugin, probe plus comprehension and cold read.";
    const start = original.indexOf(startNeedle);
    const end = original.indexOf(
      "\n# ---------------------------------------------------------------------------",
      start,
    );
    if (start < 0 || end < 0) return [];
    return [[foldOffset(original, start), foldOffset(original, end)]];
  }
  return exactMarkerRanges(file, original).cover;
}

function isolationRowLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.replaceAll(/\s+/g, " ").trim().startsWith("| `isolated-review-context` |"));
}

function assertSentencePins(): void {
  expect(BINARY_ALLOWLIST).toEqual([]);
  expect(SENTENCE_PINS).toHaveLength(3);
  for (const pin of SENTENCE_PINS) {
    const raw = readFileSync(join(REPO, pin.file), "utf8");
    expect(indicesOf(raw, pin.text).length, pin.file).toBe(1);
    if (pin.jsonKey === undefined) continue;
    expect(indicesOf(raw, `"${pin.jsonKey}"`).length, `${pin.file} ${pin.jsonKey}`).toBe(1);
    const parsed: unknown = JSON.parse(raw);
    expect(isPluginExample(parsed), pin.file).toBe(true);
    if (!isPluginExample(parsed)) continue;
    expect(parsed.description).toBe(PACKAGE_DESCRIPTION);
  }
}

function assertIsolationPin(): void {
  const pin = BLOCK_PINS.find((row) => row.file === "adapters/cursor/CONTRACT.md");
  expect(pin).toBeDefined();
  if (pin === undefined) return;
  const text = readFileSync(join(REPO, pin.file), "utf8").replaceAll("\r\n", "\n");
  const rows = isolationRowLines(text);
  expect(rows.length, "isolation rows").toBe(1);
  const interior = extractPinnedBlock(text, pin);
  expect(isolationRowLines(interior)).toEqual(rows);
  expect(textSha256(interior)).toBe(pin.sha256);
}

function offsetCovered(offset: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, stop]) => offset >= start && offset < stop);
}

function lockEntry(text: string): string {
  const startNeedle = "  # Catalog donor, no EGM plugin, probe plus comprehension and cold read.";
  const start = text.indexOf(startNeedle);
  expect(start, "lock egm entry").toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n# ---------------------------------------------------------------------------", start);
  expect(end, "lock egm entry end").toBeGreaterThan(start);
  return text.slice(start, end);
}

function contractPluginDescription(text: string): string {
  const folded = text.replaceAll("\r\n", "\n");
  const start = folded.indexOf("```json\n");
  expect(start, "plugin.json example fence").toBeGreaterThanOrEqual(0);
  const body = start + "```json\n".length;
  const end = folded.indexOf("\n```", body);
  expect(end, "plugin.json example close").toBeGreaterThan(body);
  const value: unknown = JSON.parse(folded.slice(body, end));
  expect(isPluginExample(value), "plugin.json example").toBe(true);
  if (!isPluginExample(value)) return "";
  return value.description;
}

function sectionAfter(text: string, heading: string): string {
  const needle = `## ${heading}`;
  const start = text.indexOf(needle);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + needle.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

function labelledIds(block: string, label: string): string[] {
  const match = new RegExp(`${escapeRegex(label)}:\\s*([\\s\\S]*?)(?:\\n- |\\n\\n|$)`).exec(block);
  expect(match, label).toBeTruthy();
  return (match?.[1] ?? "")
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function yamlItemBlock(text: string, idLine: string): string {
  const start = text.indexOf(idLine);
  expect(start, idLine).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + idLine.length);
  const next = rest.search(/\n  - id: /);
  return idLine + (next === -1 ? rest : rest.slice(0, next));
}

describe("EGM provenance guards", () => {
  test("hex pin prefix inside a run is identity", () => {
    const file = "package.json";
    expect(identityOffsets(file, "403d888zzzz").length).toBeGreaterThan(0);
    expect(identityOffsets(file, "403d888.").length).toBeGreaterThan(0);
    expect(identityOffsets(file, "aaaaaaa")).toEqual([]);
    expect(identityOffsets(file, `aa${EGM_COMMIT}`).length).toBeGreaterThan(0);
    expect(identityOffsets(file, `${EGM_COMMIT}aa`).length).toBeGreaterThan(0);
  });

  test("controls and combining marks fold to identity", () => {
    const file = "package.json";
    expect(identityOffsets(file, "E\0GM").length).toBeGreaterThan(0);
    expect(identityOffsets(file, "\0ＥＧＭ").length).toBeGreaterThan(0);
    expect(identityOffsets(file, "E\u0301GM").length).toBeGreaterThan(0);
    expect(identityOffsets(file, "E\rGM").length).toBeGreaterThan(0);
  });

  test("overlong UTF-8 on a non-allowlisted path is red", () => {
    expect(() => decodeTracked("README.md", OVERLONG_UTF8)).toThrow();
  });

  test("marker skip is exact-byte and file-scoped", () => {
    const file = "package.json";
    expect(identityOffsets(file, "ak-egm-smuggle").length).toBeGreaterThan(0);
    expect(identityOffsets(file, "<!-- ak-egm-begin -->").length).toBeGreaterThan(0);
    expect(identityOffsets(file, " egm ").length).toBeGreaterThan(0);
    expect(identityOffsets("README.md", "<!-- ak-egm-begin -->\n<!-- ak-egm-end -->")).toEqual([]);
    expect(identityOffsets("README.md", "<!-- AK-EGM-BEGIN -->\n<!-- AK-EGM-END -->").length).toBeGreaterThan(0);
  });

  test("node_modules skip is a path segment", () => {
    expect(skipTrackedPath("src/node_modules/x.ts")).toBe(true);
    expect(skipTrackedPath("node_modules/x.ts")).toBe(true);
    expect(skipTrackedPath("not_node_modules/x.ts")).toBe(false);
  });

  test("one-byte change to pinned sentences or isolation row is red", () => {
    assertSentencePins();
    assertIsolationPin();
    for (const pin of SENTENCE_PINS) {
      const path = join(REPO, pin.file);
      const original = readFileSync(path, "utf8");
      const mid = Math.floor(pin.text.length / 2);
      const lie = `${pin.text.slice(0, mid)}X${pin.text.slice(mid + 1)}`;
      try {
        writeFileSync(path, original.replace(pin.text, lie));
        expect(indicesOf(readFileSync(path, "utf8"), pin.text).length, pin.file).not.toBe(1);
      } finally {
        writeFileSync(path, original);
      }
    }
    const pin = BLOCK_PINS.find((row) => row.file === "adapters/cursor/CONTRACT.md");
    expect(pin).toBeDefined();
    if (pin === undefined) return;
    const path = join(REPO, pin.file);
    const original = readFileSync(path, "utf8");
    try {
      writeFileSync(path, original.replace("`partial`", "`partiaX`"));
      expect(textSha256(extractPinnedBlock(readFileSync(path, "utf8"), pin))).not.toBe(pin.sha256);
    } finally {
      writeFileSync(path, original);
    }
  });
});

describe("EGM provenance (GS-004f)", () => {
  test("pins google/elephant-goldfish-model at the PRD commit", () => {
    const { donors } = loadDonors(REPO);
    const egm = donors.get("egm");
    expect(egm?.commit).toBe(EGM_COMMIT);
    expect(egm?.license).toBe("Apache-2.0");
    const fields = loadLockDonors(REPO).get("egm");
    expect(fields).toBeDefined();
    expect(fields?.commit).toBe(EGM_COMMIT);
    expect(fields?.commit_date).toBe(EGM_COMMIT_DATE);
    expect(fields?.license).toBe("Apache-2.0");
    expect(fields?.copyright).toBe(EGM_COPYRIGHT);
    expect(fields?.license_file).toBe(EGM_LICENSE_FILE);
    expect(fields?.path).toBe(EGM_PATH);
    expect(fields?.url).toBe(EGM_URL);
    expect(fields?.repo).toBe(EGM_REPO);
  });

  test("counts twelve catalog donors, ten MIT and two Apache-2.0", () => {
    expectTwelveCatalogDonors(catalogDonorLicenses(REPO));
  });

  test("re-indenting the lock keeps the pin and the catalog counts", () => {
    const original = readFileSync(join(REPO, LOCK), "utf8");
    const rewritten = stringify(parse(original), { indent: 4 });
    const scratch = processScratch("egm-lock-indent-");
    mkdirSync(join(scratch, "provenance"));
    writeFileSync(join(scratch, LOCK), rewritten);
    cpSync(join(REPO, "provenance/adaptations.d"), join(scratch, "provenance/adaptations.d"), {
      recursive: true,
    });
    const { donors } = loadDonors(scratch);
    const egm = donors.get("egm");
    expect(egm?.commit).toBe(EGM_COMMIT);
    expect(egm?.license).toBe("Apache-2.0");
    const fields = loadLockDonors(scratch).get("egm");
    expect(fields).toBeDefined();
    expect(fields?.commit).toBe(EGM_COMMIT);
    expect(fields?.commit_date).toBe(EGM_COMMIT_DATE);
    expect(fields?.license).toBe("Apache-2.0");
    expect(fields?.copyright).toBe(EGM_COPYRIGHT);
    expect(fields?.license_file).toBe(EGM_LICENSE_FILE);
    expect(fields?.path).toBe(EGM_PATH);
    expect(fields?.url).toBe(EGM_URL);
    expect(fields?.repo).toBe(EGM_REPO);
    const yaml11 = loadLockDonors(scratch, "1.1").get("egm");
    expect(yaml11?.commit_date).toBe(EGM_COMMIT_DATE);
    expectTwelveCatalogDonors(catalogDonorLicenses(scratch));
  });

  test("hashed provenance files and unique marker blocks", () => {
    for (const pin of FILE_HASHES) {
      expect(fileSha256(join(REPO, pin.file)), pin.file).toBe(pin.sha256);
    }
    expect(textSha256(lockEntry(readFileSync(join(REPO, LOCK), "utf8"))), LOCK).toBe(LOCK_ENTRY_SHA256);
    for (const pin of BLOCK_PINS) {
      const text = readFileSync(join(REPO, pin.file), "utf8");
      expect(textSha256(extractPinnedBlock(text, pin)), pin.file).toBe(pin.sha256);
    }
    const schema: unknown = JSON.parse(readFileSync(join(REPO, "schemas/finding.schema.json"), "utf8"));
    expect(isFingerprintSchema(schema), "fingerprint description").toBe(true);
    if (!isFingerprintSchema(schema)) return;
    expect(textSha256(schema.properties.fingerprint.description), "fingerprint").toBe(FINGERPRINT_DESC_SHA256);
    for (const copy of OVERLAY_COPIES) {
      expect(existsSync(join(REPO, copy.dest)), copy.dest).toBe(true);
      expect(readFileSync(join(REPO, copy.dest)).equals(readFileSync(join(REPO, copy.src))), copy.dest).toBe(true);
    }
    const catalog = catalogDonorLicenses(REPO);
    expectTwelveCatalogDonors(catalog);
    const { catalog: loaded } = loadCatalog(REPO);
    const description = loaded?.package.description ?? "";
    expect(description.length, "catalog.yaml package.description").toBeGreaterThan(0);
    const mitCount = [...catalog.values()].filter((license) => license === "MIT").length;
    const apacheCount = [...catalog.values()].filter((license) => license === "Apache-2.0").length;
    expect(description).toContain(countWord(catalog.size));
    expect(description).toContain(countWord(mitCount));
    expect(description).toContain(countWord(apacheCount));
    expect(contractPluginDescription(readFileSync(join(REPO, "adapters/claude-code/CONTRACT.md"), "utf8"))).toBe(
      description,
    );
    expect(readFileSync(join(REPO, ".cursor/catalog.yaml"), "utf8")).toContain(description);
    assertSentencePins();
    assertIsolationPin();
  });

  test("identity strings live only in pinned regions or the allowlist", () => {
    for (const entry of IDENTITY_ALLOWLIST) {
      expect(existsSync(join(REPO, entry.file)), entry.reason).toBe(true);
      expect(entry.reason.length, entry.file).toBeGreaterThan(0);
    }
    const uncovered: string[] = [];
    const decodeLies: string[] = [];
    for (const file of trackedTextFiles()) {
      if (BINARY_ALLOWLIST.includes(file)) continue;
      let text: string;
      try {
        text = readTracked(file);
      } catch {
        decodeLies.push(file);
        continue;
      }
      const ranges = coveredRanges(file, text);
      for (const offset of identityOffsets(file, text)) {
        if (!offsetCovered(offset, ranges)) uncovered.push(`${file}:${offset}`);
      }
    }
    expect(decodeLies).toEqual([]);
    expect(uncovered).toEqual([]);
  });

  test("generated adaptations.yaml matches the fragments", () => {
    const { catalog } = loadCatalog(REPO);
    expect(catalog).not.toBeNull();
    if (catalog === null) return;
    expect(checkAdaptationsSync({ root: REPO, catalog }).filter((issue) => issue.severity === "error")).toEqual([]);
  });

  test("every egm adaptation source commit matches the lock pin", () => {
    const lockCommit = loadLockDonors(REPO).get("egm")?.commit;
    expect(lockCommit).toBe(EGM_COMMIT);
    const { rows } = loadAdaptationFragments(REPO);
    const egm = rows.filter((row) => parseDonorSource(row.source)?.donor === "egm");
    expect(egm.length).toBeGreaterThan(0);
    for (const row of egm) {
      expect(parseDonorSource(row.source)?.commit, row.file).toBe(lockCommit);
    }
  });

  test("each catalog donor's lock license matches the counted set and its licence file", () => {
    const catalog = catalogDonorLicenses(REPO);
    const { donors } = loadDonors(REPO);
    const lockDonors = loadLockDonors(REPO);
    expectTwelveCatalogDonors(catalog);
    expect(lockDonors.get("egm")?.license_file).toBe(EGM_LICENSE_FILE);
    for (const [id, license] of catalog) {
      expect(donors.get(id)?.license, id).toBe(license);
      const licenseFile = lockDonors.get(id)?.license_file;
      expect(licenseFile, id).toBeDefined();
      expect(existsSync(join(REPO, licenseFile ?? "")), licenseFile).toBe(true);
      const text = readFileSync(join(REPO, licenseFile ?? ""), "utf8");
      if (license === "Apache-2.0") {
        expect(text, licenseFile).toContain("Apache License");
        expect(text, licenseFile).toMatch(/Version 2\.0/);
      } else {
        expect(text, licenseFile).toMatch(/MIT License|Permission is hereby granted/);
      }
    }
  });

  test("research/dossiers/egm.md carries no denylist term", () => {
    const dossier = readFileSync(join(REPO, "research/dossiers/egm.md"), "utf8");
    expect(matchTerms(dossier, DENY_TERMS)).toEqual([]);
    const catalogCount = sectionAfter(dossier, "6. Catalog count");
    expect(labelledIds(catalogCount, "ten MIT").toSorted()).toEqual([...MIT_CATALOG_IDS].toSorted());
    expect(labelledIds(catalogCount, "two Apache-2.0").toSorted()).toEqual(["claude-mem", "egm"]);
  });

  test("finding.schema.json status and fingerprint descriptions name both phase-1b rulings", () => {
    const schema = readFileSync(join(REPO, "schemas/finding.schema.json"), "utf8");
    expect(schema).toMatch(/"status": \{\s*"description": "[^"]*comprehension-gap-not-contestable/);
    expect(schema).toMatch(/"fingerprint": \{\s*"description": "[^"]*comprehension-seat-stays-naive/);
  });

  test("the two phase-1b rulings name both seats and the four resolutions", () => {
    const rulings = readFileSync(join(REPO, "policies/resolved-conflicts.yaml"), "utf8");
    expect(rulings).toContain("id: comprehension-seat-stays-naive");
    expect(rulings).toContain("id: comprehension-gap-not-contestable");
    expect(rulings).toContain("ticket cold reader");
    expect(rulings).toContain("never rejected on the author's word");
    expect(yamlItemBlock(rulings, "\n  - id: comprehension-seat-stays-naive\n")).toContain("references: [delegation]");
    const delegation = readFileSync(join(REPO, "references/delegation/REFERENCE.md"), "utf8");
    expect(delegation).toContain("no prior-finding packet (ruling `comprehension-seat-stays-naive`)");
    expect(readFileSync(join(REPO, "skills/super-bound/SKILL.md"), "utf8")).toContain("comprehension-seat-stays-naive");
    expect(readFileSync(join(REPO, "skills/super-bound/skill.yaml"), "utf8")).toContain(
      "comprehension-seat-stays-naive",
    );
  });
});
