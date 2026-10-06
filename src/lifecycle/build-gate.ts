import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import standaloneCode from "ajv/dist/standalone/index.js";
import { compileVerificationSchema } from "./verification-schema.ts";

const [source, outfile, adapterIds] = process.argv.slice(2);
if (source === undefined || outfile === undefined || adapterIds === undefined)
  throw new Error("build-gate requires source, outfile and adapter ids");
const root = dirname(dirname(dirname(source)));
const { ajv, validate } = compileVerificationSchema(root);
const standalone = standaloneCode(ajv, validate);
const adapterDeclaration = "const BUNDLED_ADAPTER_IDS: readonly string[] = [];";
const result = await Bun.build({
  entrypoints: [source],
  target: "node",
  format: "esm",
  plugins: [
    {
      name: "verification-schema",
      setup(build) {
        build.onLoad({ filter: /[/\\]verification-schema\.ts$/ }, () => ({ contents: standalone, loader: "js" }));
        build.onLoad({ filter: /[/\\]gate\.ts$/ }, (args) => ({
          contents: readFileSync(args.path, "utf8").replace(
            adapterDeclaration,
            `const BUNDLED_ADAPTER_IDS: readonly string[] = ${adapterIds};`,
          ),
          loader: "ts",
        }));
      },
    },
  ],
});
if (!result.success) throw new Error(result.logs.map(String).join("\n"));
const output = result.outputs[0];
if (output === undefined) throw new Error("gate build produced no output");
await Bun.write(outfile, await output.text());
