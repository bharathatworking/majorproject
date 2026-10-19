/**
 * Version and commit of this build, for the run report (lib/run/simplify.ts).
 *
 * vite.config.ts `define` replaces __APP_VERSION__ (package.json version)
 * and __GIT_COMMIT__ (short hash, "-dirty" with uncommitted changes, null
 * outside git) at build time. Under vitest they are not defined, so each is
 * read behind a typeof guard: 'dev' and null.
 */

/** package.json version of this build; 'dev' when not built by Vite. */
export function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
}

/** Git commit of this build; null when unknown. */
export function gitCommit(): string | null {
  return typeof __GIT_COMMIT__ === 'string' ? __GIT_COMMIT__ : null;
}
