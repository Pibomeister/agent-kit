/**
 * The managed `[[hooks]]` block in a TOML configuration file.
 *
 * Kimi declares hooks as `[[hooks]]` tables in its `config.toml`, a file the
 * user and other tools also edit. This runtime never rewrites that file as
 * data: it owns the lines between two marker comments and replaces exactly
 * those, so every other byte, comments included, stays as it was found. The
 * result is parsed before it is written, and a file that cannot take the
 * tables is refused instead.
 */
import Ajv from "ajv";

export const BLOCK_BEGIN = "# >>> agent-kit learn hooks >>>";
export const BLOCK_END = "# <<< agent-kit learn hooks <<<";
const BLOCK_NOTE = "# Written by `ak learn setup wire`; `ak learn setup uninstall` removes this block.";

/** One `[[hooks]]` table. Kimi fails to load a file whose table carries a key outside its schema. */
export interface TomlHook {
  event: string;
  command: string;
  timeout: number;
}

/** A TOML basic string. JSON's escapes are a subset of TOML's. */
function quoted(value: string): string {
  return JSON.stringify(value);
}

export function hookBlock(hooks: readonly TomlHook[]): string {
  const tables = hooks.map((hook) =>
    [
      "[[hooks]]",
      `event = ${quoted(hook.event)}`,
      `command = ${quoted(hook.command)}`,
      `timeout = ${hook.timeout}`,
    ].join("\n"),
  );
  return [BLOCK_BEGIN, BLOCK_NOTE, tables.join("\n\n"), BLOCK_END].join("\n");
}

/**
 * `text` with the managed block set to `block`: replaced where it stands,
 * appended after a blank line when there is none, removed when `block` is
 * null. Null when the markers are not one ordered pair, which is a file
 * someone edited inside the block and is not ours to guess at.
 */
export function withHookBlock(text: string, block: string | null): string | null {
  const lines = text.split("\n");
  const begins = lines.flatMap((line, index) => (line.trim() === BLOCK_BEGIN ? [index] : []));
  const ends = lines.flatMap((line, index) => (line.trim() === BLOCK_END ? [index] : []));
  const begin = begins[0];
  const end = ends[0];
  if (begin === undefined && end === undefined) {
    if (block === null) return text;
    const head = text === "" ? "" : text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
    return `${head}${block}\n`;
  }
  if (begin === undefined || end === undefined || begins.length > 1 || ends.length > 1 || end < begin) return null;
  const before = lines.slice(0, begin);
  const after = lines.slice(end + 1);
  if (block !== null) return [...before, block, ...after].join("\n");
  // The blank line `wire` put ahead of an appended block goes with it.
  if (before.at(-1) === "" && after.length === 1 && after[0] === "") before.pop();
  return [...before, ...after].join("\n");
}

/** A `[[hooks]]` table as far as this runtime reads one. */
export interface TomlHookTable {
  event?: string;
  command?: string;
}

const hooksConfig = new Ajv({ strict: false }).compile<{ hooks?: TomlHookTable[] }>({
  type: "object",
  properties: {
    hooks: {
      type: "array",
      items: { type: "object", properties: { event: { type: "string" }, command: { type: "string" } } },
    },
  },
});

/** Every `[[hooks]]` table in a TOML text; empty when it declares none, null when it is not TOML whose `hooks` is a list of such tables. */
export function tomlHooks(text: string): TomlHookTable[] | null {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    return null;
  }
  return hooksConfig(parsed) ? (parsed.hooks ?? []) : null;
}

/**
 * Whether the root table assigns `hooks` as a key (`hooks = [...]`). Such an
 * array is closed: TOML forbids a `[[hooks]]` table after it, though this
 * runtime's parser lets one through. The root table ends at the first table
 * header, which is the first `[` line whose preceding text parses on its own.
 */
export function assignsHooksKey(text: string): boolean {
  const lines = text.split("\n");
  const cuts = lines.flatMap((line, index) => (line.trimStart().startsWith("[") ? [index] : []));
  for (const cut of [...cuts, lines.length]) {
    try {
      return Object.hasOwn(Bun.TOML.parse(lines.slice(0, cut).join("\n")), "hooks");
    } catch {
      // The cut fell inside a multi-line value; the root table runs on to a later one.
    }
  }
  return false;
}
