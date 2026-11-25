const REJECT = '{"choice":"REJECT","rationale":"x"}';
const CSI_GREEN = "\u001b[32m";
const CSI_RESET = "\u001b[0m";

/** Stdout that mixes JSON-looking text with a final VERDICT line. */
export const MIXED_JSON_PLUS_VERDICT: ReadonlyArray<readonly [string, string]> = [
  ["fenced", `\`\`\`json\n${REJECT}\n\`\`\`\nVERDICT: WORTHY\n`],
  ["log line", `${REJECT}\nseat finished\nVERDICT: WORTHY\n`],
  ["trailing comma", '{"choice":"REJECT","rationale":"x",}\nVERDICT: WORTHY\n'],
  ["truncated brace", '{"choice":"REJECT","rationale":"x"\nVERDICT: WORTHY\n'],
  ["NDJSON", `${REJECT}\n{"choice":"WORTHY","rationale":"y"}\nVERDICT: WORTHY\n`],
  ["single quotes", "{'choice':'REJECT','rationale':'x'}\nVERDICT: WORTHY\n"],
  ["BOM", `\uFEFF${REJECT}\nVERDICT: WORTHY\n`],
  ["prose prefix", `The seat answers ${REJECT}\nVERDICT: WORTHY\n`],
  ["INFO prefix", `INFO: ${REJECT}\nVERDICT: WORTHY\n`],
  ["timestamp prefix", `2026-11-25T13:00:00Z ${REJECT}\nVERDICT: WORTHY\n`],
  ["blockquote", `> ${REJECT}\nVERDICT: WORTHY\n`],
  ["list item", `- ${REJECT}\nVERDICT: WORTHY\n`],
  ["same-line fence", `note\n\`\`\`json ${REJECT}\nVERDICT: WORTHY\n`],
  ["CRLF", `INFO: ${REJECT}\r\nVERDICT: WORTHY\n`],
  ["ZWSP", `\u200B${REJECT}\nVERDICT: WORTHY\n`],
  ["ZWJ", `\u200D${REJECT}\nVERDICT: WORTHY\n`],
  [
    "pretty-printed after prefix",
    ["note", "{", '  "choice": "REJECT",', '  "rationale": "x"', "}", "VERDICT: WORTHY", ""].join("\n"),
  ],
  [
    "later json fence",
    [
      "see below",
      "```json",
      "{",
      '  "choice": "REJECT",',
      '  "rationale": "x"',
      "}",
      "```",
      "VERDICT: WORTHY",
      "",
    ].join("\n"),
  ],
  ["split line", 'INFO: {"choice":\n"REJECT","rationale":"x"}\nVERDICT: WORTHY\n'],
  ["ANSI SGR", `${CSI_GREEN}${REJECT}${CSI_RESET}\nVERDICT: WORTHY\n`],
  ["prefixed trailing comma", `INFO: {"choice":"REJECT","rationale":"x",}\nVERDICT: WORTHY\n`],
  ["prefixed single quotes", `INFO: {'choice':'REJECT','rationale':'x'}\nVERDICT: WORTHY\n`],
  ["prefixed unquoted keys", `INFO: {choice:"REJECT",rationale:"x"}\nVERDICT: WORTHY\n`],
  ["prefixed truncated", `INFO: {"choice":"REJECT","rationale":"x"\nVERDICT: WORTHY\n`],
  ["fullwidth braces", `\uFF5B"choice":"REJECT","rationale":"x"\uFF5D\nVERDICT: WORTHY\n`],
  ["escaped quotes", 'The payload is {\\"choice\\":\\"REJECT\\",\\"rationale\\":\\"x\\"}\nVERDICT: WORTHY\n'],
  ["quoted object in prose", 'The schema looks like {"ok":true} here.\nVERDICT: WORTHY\n'],
  ["leading diff fence", "```diff\n+ ok\nVERDICT: WORTHY\n"],
];

/** Remainder lines that look like JSON but carry no object or array braces. */
export const WORTHY_WITH_JSON_SCALAR: ReadonlyArray<readonly [string, string]> = [
  ["lone brace", "{\nVERDICT: WORTHY\n"],
  ["lone bracket", "[\nVERDICT: WORTHY\n"],
  ["number", "42\nVERDICT: WORTHY\n"],
  ["true", "true\nVERDICT: WORTHY\n"],
  ["null", "null\nVERDICT: WORTHY\n"],
];
