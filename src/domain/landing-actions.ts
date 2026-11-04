/**
 * The landing's second action (PIN-264), next to "Start a board".
 * Pure: the page passes whether the demo is on and the signed-in
 * visitor's own board slugs (null when signed out or unknown).
 * Someone who already has boards gets their boards; everyone else
 * gets the demo, when there is one.
 */
export type LandingSecondary =
  | { kind: "demo" }
  | { kind: "myBoard"; slug: string }
  | { kind: "myBoards" }
  | { kind: "none" };

export function landingSecondary(input: {
  demoEnabled: boolean;
  myBoardSlugs: readonly string[] | null;
}): LandingSecondary {
  const slugs = input.myBoardSlugs ?? [];
  if (slugs.length === 1 && slugs[0]) return { kind: "myBoard", slug: slugs[0] };
  if (slugs.length > 1) return { kind: "myBoards" };
  return input.demoEnabled ? { kind: "demo" } : { kind: "none" };
}
