// Local typings for compromise-numbers.
// The package ships types/index.d.ts, but its package.json "exports" map has no
// "types" condition, so TypeScript's bundler resolution can't find them (TS7016).
// Only the subset ner.ts uses is declared; .numbers() returns a regular View.
declare module 'compromise-numbers' {
  import nlp from 'compromise';

  type View = ReturnType<typeof nlp>;

  export interface NumbersMethods {
    /** grab all written and numeric values */
    numbers(n?: number): View;
  }

  const nlpNumbers: nlp.TypedPlugin<NumbersMethods>;
  export default nlpNumbers;
}
