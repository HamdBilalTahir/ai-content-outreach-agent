/**
 * A local declaration for the slice of `papaparse` this repo uses.
 *
 * `@types/papaparse` could not be installed: this repo has a **pre-existing** peer conflict — it pins
 * `dotenv@^17` while `@browserbasehq/stagehand` (reached through `@langchain/community`) requires `^16` —
 * and that makes every `npm install` fail unless forced with `--legacy-peer-deps`. Forcing a repo-wide
 * resolution change to obtain type declarations for one CSV parser is the wrong trade, and TypeScript's
 * own error text offers this as the alternative.
 *
 * Deliberately narrow: only the one `parse` overload `audience/parse-file.ts` calls, typed exactly as it
 * uses it. A wider guess would be fiction, and the narrow version fails loudly the moment someone needs
 * more of the library — at which point installing the real types (or fixing the dotenv conflict) is the
 * right answer rather than growing this file.
 */
declare module 'papaparse' {
  export interface ParseMeta {
    /** Column names, present because the call sets `header: true`. */
    fields?: string[];
  }

  export interface ParseResult<T> {
    data: T[];
    meta: ParseMeta;
  }

  export interface ParseConfig<T> {
    header?: boolean;
    skipEmptyLines?: boolean;
    delimitersToGuess?: string[];
    complete?: (results: ParseResult<T>) => void;
    error?: (error: Error) => void;
  }

  /** The `File` overload — the browser upload path. */
  export function parse<T>(file: File, config: ParseConfig<T>): void;

  const Papa: { parse: typeof parse };
  export default Papa;
}
