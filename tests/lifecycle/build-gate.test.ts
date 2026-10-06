import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTree } from "../helpers/tree.ts";

const ROOT = join(import.meta.dir, "..", "..");
const generator = join(ROOT, "src/lifecycle/build-gate.ts");

function fixture(source: string) {
  const root = makeTree({
    "src/lifecycle/gate.ts": source,
    "src/lifecycle/verification-schema.ts": "export default () => false;\n",
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
import validate from "./verification-schema.ts";
console.log(JSON.stringify({ adapters: BUNDLED_ADAPTER_IDS, accepted: validate(JSON.parse(process.argv[2])) }));
`);
  expect(built.exitCode, built.stderr.toString()).toBe(0);
  const receipt = readFileSync(join(ROOT, "templates/verification.example.json"), "utf8");
  const checked = Bun.spawnSync(["node", script, receipt], { cwd: root });
  expect(checked.exitCode, checked.stderr.toString()).toBe(0);
  expect(JSON.parse(checked.stdout.toString())).toEqual({ adapters: ["test-host"], accepted: true });
});

test("the gate builder refuses a source that cannot receive its adapter ids", () => {
  const { root, built } = fixture("console.log('gate input');\n");
  expect(built.exitCode).not.toBe(0);
  expect(built.stderr.toString()).toContain(
    `${join(root, "src/lifecycle/gate.ts")}: bundled adapter declaration missing`,
  );
});
