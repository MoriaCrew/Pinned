/**
 * Files still allowed to pass the literal "en" locale to `t`, `tf`
 * or `tCount` (PIN-190, docs/18-i18n.md).
 * no-hardcoded-locale.test.ts fails on any other file, and on a
 * listed file that no longer needs its entry.
 *
 * Each block belongs to one PIN-23 child issue. When that issue's
 * files read the user's language, it deletes its own comment and
 * lines and leaves the blank lines, so parallel PRs merge cleanly.
 *
 * Never add a file here. Use `useLocale()` from `src/i18n/client`
 * in client components, `await getLocale()` from `src/i18n/server`
 * on the server.
 */
export const EN_ONLY_FILES: readonly string[] = [
  // PIN-196 server errors (rest: PIN-201)
  "src/gateway/decorators.ts",
  "src/server/dictation.ts",

  // Stays English: link-preview images are fetched by crawlers, which send no language
  "src/app/g/[slug]/opengraph-image.tsx",
  "src/domain/board-card.ts",
  "src/server/board-card-image.tsx",
];
