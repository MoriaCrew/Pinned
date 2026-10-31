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
  // PIN-191 language switcher
  "src/app/auth/You.tsx",

  // PIN-193 board page and sheets
  "src/app/g/[slug]/BoardClient.tsx",
  "src/app/g/[slug]/BoardScenes.tsx",
  "src/app/g/[slug]/BoardThings.tsx",
  "src/app/g/[slug]/ChangeLookSheet.tsx",
  "src/app/g/[slug]/DeleteBoardSheet.tsx",
  "src/app/g/[slug]/JoinSheet.tsx",
  "src/app/g/[slug]/MakeSheet.tsx",
  "src/app/g/[slug]/PlusFlow.tsx",
  "src/app/g/[slug]/RenameSheet.tsx",
  "src/app/g/[slug]/SceneViewer.tsx",
  "src/app/g/[slug]/page.tsx",

  // PIN-194 UI kit
  "src/ui/board.tsx",
  "src/ui/primitives.tsx",
  "src/ui/scenes.tsx",
  "src/ui/skin-picker.tsx",
  "src/ui/stickers.tsx",

  // PIN-195 landing, start, My boards/pins, not-found, sign-in
  "src/app/auth/SignInButton.tsx",
  "src/app/me/BoardDeletedNotice.tsx",
  "src/app/me/LibraryParts.tsx",
  "src/app/me/boards/MyBoardItem.tsx",
  "src/app/me/boards/page.tsx",
  "src/app/me/library-format.ts",
  "src/app/me/pins/page.tsx",
  "src/app/new/StartFlow.tsx",
  "src/app/new/page.tsx",
  "src/app/not-found.tsx",
  "src/app/page.tsx",

  // PIN-196 server errors
  "src/gateway/decorators.ts",
  "src/server/board-api.ts",
  "src/server/board-plus.ts",
  "src/server/decompose-job.ts",
  "src/server/dictation.ts",
  "src/server/scene-job.ts",

  // PIN-197 route errors
  "src/app/api/boards/[slug]/transcribe/route.ts",
  "src/app/api/boards/request-guards.ts",

  // Stays English: link-preview images are fetched by crawlers, which send no language
  "src/app/g/[slug]/opengraph-image.tsx",
  "src/domain/board-card.ts",
  "src/server/board-card-image.tsx",
];
