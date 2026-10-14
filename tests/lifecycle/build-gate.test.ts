import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeTree } from "../helpers/tree.ts";
import { parseJson } from "../helpers/json.ts";

const ROOT = join(import.meta.dir, "..", "..");
const generator = join(ROOT, "src/lifecycle/build-gate.ts");

function fixture(source: string) {
  const root = makeTree({
    "src/lifecycle/gate.ts": source,
    "src/lifecycle/verification-schema.ts": "export const verificationValidator = () => () => false;\n",
    "schemas/common.schema.json": readFileSync(join(ROOT, "schemas/common.schema.json"), "utf8"),
    "schemas/verification.schema.json": readFileSync(join(ROOT, "schemas/verification.schema.json"), "utf8"),
  });
  const script = join(root, "gate.mjs");
  const built = Bun.spawnSync(
    [process.execPath, generator, join(root, "src/lifecycle/gate.ts"), script, '["test-host"]'],
    {
      cwd: root,
    },
  );
  return { root, script, built };
}

test("the gate builder emits schema-derived validation and adapter ids for standalone Node", () => {
  const { root, script, built } = fixture(`
const BUNDLED_ADAPTER_IDS: readonly string[] = [];
import { verificationValidator } from "./verification-schema.ts";
const validate = verificationValidator();
console.log(JSON.stringify({ adapters: BUNDLED_ADAPTER_IDS, accepted: validate(JSON.parse(process.argv[2])), malformed: validate({ ...JSON.parse(process.argv[2]), project: { id: "example-project", repo: null } }) }));
`);
  expect(built.exitCode, built.stderr.toString()).toBe(0);
  const receipt = readFileSync(join(ROOT, "templates/verification.example.json"), "utf8");
  const checked = Bun.spawnSync(["node", script, receipt], { cwd: root });
  expect(checked.exitCode, checked.stderr.toString()).toBe(0);
  expect(JSON.parse(checked.stdout.toString())).toEqual({ adapters: ["test-host"], accepted: true, malformed: false });
  const overflow = parseJson(receipt);
  if (!(overflow instanceof Object) || Array.isArray(overflow)) throw new Error("Expected a receipt object");
  overflow.status = "failed";
  overflow.exit_status = "overflow";
  const raw = JSON.stringify(overflow).replace('"exit_status":"overflow"', '"exit_status":1e400');
  const refused = Bun.spawnSync(["node", script, raw], { cwd: root });
  expect(refused.exitCode, refused.stderr.toString()).toBe(0);
  expect(JSON.parse(refused.stdout.toString())).toEqual({ adapters: ["test-host"], accepted: false, malformed: false });
}, 60_000);

test("the gate builder refuses a source that cannot receive its adapter ids", () => {
  const { root, built } = fixture("console.log('gate input');\n");
  expect(built.exitCode).not.toBe(0);
  expect(built.stderr.toString()).toContain(
    `${join(root, "src/lifecycle/gate.ts")}: bundled adapter declaration missing`,
  );
}, 60_000);

test("independent gate-builder processes emit identical output without builder paths", () => {
  const source = `const BUNDLED_ADAPTER_IDS: readonly string[] = [];
import { verificationValidator } from "./verification-schema.ts";
console.log(JSON.stringify({ adapters: BUNDLED_ADAPTER_IDS, accepted: verificationValidator()(JSON.parse(process.argv[2])) }));`;
  const first = fixture(source);
  const second = fixture(source);
  expect(first.built.exitCode, first.built.stderr.toString()).toBe(0);
  expect(second.built.exitCode, second.built.stderr.toString()).toBe(0);
  const a = readFileSync(first.script, "utf8");
  const b = readFileSync(second.script, "utf8");
  expect(a).toBe(b);
  for (const path of [ROOT, first.root, second.root, tmpdir()]) {
    expect(a).not.toContain(path);
    expect(b).not.toContain(path);
  }
}, 60_000);
