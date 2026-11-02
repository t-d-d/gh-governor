// The part of commonmark.js the receiver uses (subscribe.mjs), declared
// beside the copy so tsc reads this and not the copy's JavaScript, which
// tsconfig.json excludes.

/** A block's first and last line and column, each counted from 1. */
type SourcePos = [[number, number], [number, number]];

interface Node {
  type: string;
  /** Set on a block node; an inline node has none. */
  sourcepos?: SourcePos;
  walker(): Walker;
}

interface Walker {
  /** The next node, on the way in and again on the way out of a container, or null at the end. */
  next(): { node: Node; entering: boolean } | null;
}

declare class Parser {
  constructor(options?: object);
  parse(input: string): Node;
  /** Parses the text of each paragraph and heading once the blocks are read; replaced on an instance to skip it. */
  processInlines(block: Node): void;
}

declare const commonmark: { Parser: typeof Parser };
export = commonmark;
