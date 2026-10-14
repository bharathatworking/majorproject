// Local typings for compromise-numbers.
// The package ships types/index.d.ts, but its package.json "exports" map has no
// "types" condition, so TypeScript's bundler resolution can't find them (TS7016).
// Only the subset Clarity uses is declared: .numbers() returns a regular View
// plus get() (parsed values, used by the entity check in lib/quality/semantic.ts).
declare module 'compromise-numbers' {
  import nlp from 'compromise';

  type View = ReturnType<typeof nlp>;

  export interface NumbersView {
    /** parsed value(s): 'three' → 3, '1,500' → 1500 */
    get(n?: number): number | number[];
  }

  export interface NumbersMethods {
    /** grab all written and numeric values */
    numbers(n?: number): View & NumbersView;
  }

  const nlpNumbers: nlp.TypedPlugin<NumbersMethods>;
  export default nlpNumbers;
}
