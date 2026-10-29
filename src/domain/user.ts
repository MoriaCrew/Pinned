/**
 * Signed-in user entities (PIN-83, docs/11 section 5.4). Pure
 * types only — persistence lives behind UserRepository
 * (user-repository.ts). Times are epoch-ms numbers.
 *
 * Privacy: the profile stores the minimum the library UI needs
 * (uid + optional display name / photo from the provider token).
 * Email is deliberately NOT stored: nothing in PIN-57 sends mail
 * or keys identity off an address, and the ID token is only ever
 * read for uid/name/picture. If a future feature truly needs an
 * email, it must justify storing one in its own issue.
 */

/** One Firebase Auth user (`users/{uid}`). */
export interface UserProfile {
  uid: string;
  displayName?: string;
  photoUrl?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One board in a user's library index (`users/{uid}/boards/{slug}`):
 * the Participant on that board claimed by / joined as this user.
 * Written on claim and on join-while-signed-in; `claimedAt` is the
 * first link time and survives later refreshes.
 */
export interface UserBoardEntry {
  boardId: string; // = Board.slug
  participantId: string; // Participant.id on that board
  claimedAt: number;
  updatedAt: number;
}
