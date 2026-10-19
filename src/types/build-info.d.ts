/**
 * Build constants that vite.config.ts `define` replaces at build time (the
 * package.json version and the git commit), for the run report. Not defined
 * under vitest; read them through src/lib/utils/build-info.ts, which guards
 * with typeof.
 */
declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string | null;
