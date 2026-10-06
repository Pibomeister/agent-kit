/** Text the learning runtime embeds with `with { type: "text" }`, so the single-file bundle needs no files beside it. */
declare module "*.md" {
  const text: string;
  export default text;
}

declare module "*.tmpl" {
  const text: string;
  export default text;
}
