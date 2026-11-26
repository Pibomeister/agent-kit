declare module "commonmark" {
  export class Node {
    type: string;
    literal: string | null;
    walker(): { next(): { entering: boolean; node: Node } | null };
  }
  export class Parser {
    parse(markdown: string): Node;
  }
}
