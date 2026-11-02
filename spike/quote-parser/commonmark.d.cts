// The types the receiver would need for a copied commonmark.js, kept beside
// the copy so tsc reads these and not the copy's JavaScript.
type Position = [[number, number], [number, number]];
interface Node { type: string; sourcepos?: Position }
interface Walker { next(): { node: Node; entering: boolean } | null }
declare class Parser { parse(text: string): { walker(): Walker } }
declare const commonmark: { Parser: typeof Parser };
export = commonmark;
