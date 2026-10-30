import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TokenVerifier } from "../../../server/token-verifier";

/**
 * Optional-mode route flow (PIN-83 Checks): real route handlers
 * against the memory backends with a FakeTokenVerifier swapped
 * in through the test seam. Env must be set BEFORE the route
 * modules first read config, so handlers are imported
 * dynamically in beforeAll. Synthetic uids/tokens only.
 */
const SECRET = "test-secret-test-secret-test-secret-32";

process.env.AUTH_MODE = "optional";
process.env.SESSION_SECRET = SECRET;
process.env.DATA_BACKEND = "memory";

type Handler = (request: Request, context?: never) => Promise<Response>;
type SlugHandler = (
  request: Request,
  context: { params: Promise<{ slug: string }> },
) => Promise<Response>;

let postSession: Handler;
let deleteSession: Handler;
let getMe: Handler;
let createBoardRoute: Handler;
let joinRoute: SlugHandler;
let claimRoute: SlugHandler;
let boardGetRoute: SlugHandler;
let myBoardsRoute: Handler;
let myElementsRoute: Handler;
let myElementImageRoute: (
  request: Request,
  context: { params: Promise<{ elementId: string }> },
) => Promise<Response>;
let fromLibraryRoute: SlugHandler;
let seedElement: (boardId: string, ownerId: string) => Promise<void>;
let tokenVerifier: TokenVerifier;
/** A participant's userId and where that user's board index points. */
let linkState: (
  slug: string,
  participantId: string,
) => Promise<{ userId?: string; indexed?: string }>;
let participantCount: (slug: string) => Promise<number>;

beforeAll(async () => {
  const { FakeTokenVerifier, setTokenVerifierForTests } =
    await import("../../../server/token-verifier");
  setTokenVerifierForTests(
    (tokenVerifier = new FakeTokenVerifier({
      "token-alice": {
        uid: "synthetic-alice",
        displayName: "Alice A",
        photoUrl: "https://example.test/alice.png",
      },
      "token-bob": { uid: "synthetic-bob" },
      // PIN-94 fixtures: wrong provider, revoked, stale sign-in
      // (same alice uid, auth_time 2h before the suite runs).
      "token-anon": { uid: "synthetic-anon", signInProvider: "anonymous" },
      "token-revoked": { uid: "synthetic-revoked", revoked: true },
      "token-alice-stale": {
        uid: "synthetic-alice",
        displayName: "Alice A",
        authTimeMs: Date.now() - 2 * 60 * 60 * 1000,
      },
    })),
  );
  ({ POST: postSession, DELETE: deleteSession } = await import("./session/route"));
  ({ GET: getMe } = await import("../me/route"));
  ({ POST: createBoardRoute } = await import("../boards/route"));
  ({ POST: joinRoute } = await import("../boards/[slug]/participants/route"));
  ({ POST: claimRoute } = await import("../boards/[slug]/claim/route"));
  ({ GET: boardGetRoute } = await import("../boards/[slug]/route"));
  ({ GET: myBoardsRoute } = await import("../me/boards/route"));
  ({ GET: myElementsRoute } = await import("../me/elements/route"));
  ({ GET: myElementImageRoute } = await import(
    "../me/elements/[elementId]/image/route"
  ));
  ({ POST: fromLibraryRoute } = await import(
    "../boards/[slug]/pins/from-library/route"
  ));
  const { getBoardRepository } = await import("../../../server/board-repository");
  const { getDerivativeStore } = await import("../../../server/derivative-store");
  const { getUserRepository } = await import("../../../server/user-repository");
  linkState = async (slug, participantId) => {
    const participant = await getBoardRepository().getParticipant(slug, participantId);
    const userId = participant?.userId;
    if (!userId) return {};
    const entry = await getUserRepository().getUserBoard(userId, slug);
    return { userId, ...(entry ? { indexed: entry.participantId } : {}) };
  };
  participantCount = async (slug) =>
    (await getBoardRepository().listParticipants(slug)).length;
  seedElement = async (boardId, ownerId) => {
    await getBoardRepository().createElement({
      id: "route-el-1",
      boardId,
      ownerId,
      label: "Route Lamp",
      description: "",
      maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
      cutoutRef: "elements/route-el-1/cutout.png",
      flattenedRef: "elements/route-el-1/flattened.jpg",
      sourcePhotoId: "photo-1",
      faceFlag: false,
      createdAt: 1,
    });
    // The library lists pinned things only (PIN-125).
    await getBoardRepository().createPin({
      id: "route-pin-1",
      boardId,
      elementId: "route-el-1",
      pinnedBy: ownerId,
      status: "pinned",
      createdAt: 1,
    });
    await getDerivativeStore().put(
      "elements/route-el-1/cutout.png",
      Buffer.from("png-bytes"),
      "image/png",
    );
  };
});

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

/** What the app's own fetch sends (PIN-160 login-CSRF guard). */
const SAME_ORIGIN_JSON = {
  "content-type": "application/json",
  "sec-fetch-site": "same-origin",
};

function sessionReq(idToken: string, headers: HeadersInit = SAME_ORIGIN_JSON): Request {
  return req("http://t/api/auth/session", {
    method: "POST",
    headers,
    body: JSON.stringify({ idToken }),
  });
}

function slugParams(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

/** `name=value` pair from a Set-Cookie header, for replay. */
function cookiePair(res: Response): string {
  const header = res.headers.get("set-cookie");
  expect(header).not.toBeNull();
  return header!.split(";")[0];
}

async function signIn(idToken: string): Promise<string> {
  const res = await postSession(sessionReq(idToken));
  expect(res.status).toBe(200);
  return cookiePair(res);
}

/** `ip` gives a test its own board-create rate-limit bucket. */
async function makeBoard(title: string, ip?: string): Promise<string> {
  const res = await createBoardRoute(
    req("http://t/api/boards", {
      method: "POST",
      ...(ip ? { headers: { "x-forwarded-for": ip } } : {}),
      body: JSON.stringify({ title }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { board: { slug: string } };
  return body.board.slug;
}

async function join(
  slug: string,
  displayName: string,
  cookie?: string,
): Promise<{ res: Response; participantCookie: string }> {
  const res = await joinRoute(
    req(`http://t/api/boards/${slug}/participants`, {
      method: "POST",
      headers: { ...SAME_ORIGIN_JSON, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ displayName }),
    }),
    slugParams(slug),
  );
  return { res, participantCookie: cookiePair(res) };
}

async function participantIdOf(res: Response): Promise<string> {
  return ((await res.clone().json()) as { participant: { id: string } }).participant.id;
}

describe("AUTH_MODE=optional: session, /api/me, claim, join auto-link", () => {
  it("GET /api/me without a session is 401; a bad ID token is 401", async () => {
    const me = await getMe(req("http://t/api/me"));
    expect(me.status).toBe(401);

    const bad = await postSession(sessionReq("not-a-token"));
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  it("sign-in sets an httpOnly Lax user cookie; /api/me reads it; tamper is 401", async () => {
    const res = await postSession(sessionReq("token-alice"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user).toMatchObject({
      uid: "synthetic-alice",
      displayName: "Alice A",
      photoUrl: "https://example.test/alice.png",
    });
    expect(body.user).not.toHaveProperty("email");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("pinned_user=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");

    const cookie = cookiePair(res);
    const me = await getMe(req("http://t/api/me", { headers: { cookie } }));
    expect(me.status).toBe(200);
    expect((await me.json()).user.uid).toBe("synthetic-alice");

    const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
    const forged = await getMe(
      req("http://t/api/me", { headers: { cookie: tampered } }),
    );
    expect(forged.status).toBe(401);
  });

  it("PIN-160: sign-in refuses cross-site (403) and non-JSON (415) before any verify", async () => {
    // Refused before the rate limit, so this spends no sign-in budget.
    const verify = vi.spyOn(tokenVerifier, "verifyIdToken");
    try {
      for (const site of ["cross-site", "same-site", "none"]) {
        const res = await postSession(
          sessionReq("token-alice", {
            "content-type": "application/json",
            "sec-fetch-site": site,
          }),
        );
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe("cross_site");
        expect(res.headers.get("set-cookie")).toBeNull();
      }
      // A cross-site HTML form can only post text/plain.
      const form = await postSession(
        sessionReq("token-alice", { "content-type": "text/plain" }),
      );
      expect(form.status).toBe(415);
      expect((await form.json()).code).toBe("unsupported_media_type");
      expect(form.headers.get("set-cookie")).toBeNull();
      expect(verify).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
    }
  });

  it("claim: needs both sessions, same user ok, other user 409, missing board 404", async () => {
    const aliceCookie = await signIn("token-alice");
    const bobCookie = await signIn("token-bob");
    const slug = await makeBoard("Claim route board");

    // Missing board (valid slug shape) -> 404 even when signed in.
    const missing = await claimRoute(
      req("http://t/x", { method: "POST", headers: { cookie: aliceCookie } }),
      slugParams("AAAAAAAAAAAAAAAAAAAAAg"),
    );
    expect(missing.status).toBe(404);

    // Signed in but not joined -> 401.
    const notJoined = await claimRoute(
      req("http://t/x", { method: "POST", headers: { cookie: aliceCookie } }),
      slugParams(slug),
    );
    expect(notJoined.status).toBe(401);

    // Joined while signed out, claim without a user session -> 401.
    const { res: joinRes, participantCookie } = await join(slug, "Aye");
    expect(joinRes.status).toBe(201);
    const noUser = await claimRoute(
      req("http://t/x", { method: "POST", headers: { cookie: participantCookie } }),
      slugParams(slug),
    );
    expect(noUser.status).toBe(401);

    // Both cookies -> claimed.
    const both = `${participantCookie}; ${aliceCookie}`;
    const claimed = await claimRoute(
      req("http://t/x", { method: "POST", headers: { cookie: both } }),
      slugParams(slug),
    );
    expect(claimed.status).toBe(200);
    const claimedBody = await claimed.json();
    expect(claimedBody.userId).toBe("synthetic-alice");
    expect(claimedBody.participant.displayName).toBe("Aye");

    // Same user again -> 200.
    const again = await claimRoute(
      req("http://t/x", { method: "POST", headers: { cookie: both } }),
      slugParams(slug),
    );
    expect(again.status).toBe(200);

    // A different user with the same participant cookie -> 409.
    const conflict = await claimRoute(
      req("http://t/x", {
        method: "POST",
        headers: { cookie: `${participantCookie}; ${bobCookie}` },
      }),
      slugParams(slug),
    );
    expect(conflict.status).toBe(409);
  });

  it("join-while-signed-in auto-claims: another user's claim then 409s", async () => {
    const aliceCookie = await signIn("token-alice");
    const bobCookie = await signIn("token-bob");
    const slug = await makeBoard("Auto-link board");

    // Bob joins while signed in: no explicit claim call.
    const { res, participantCookie } = await join(slug, "Bee", bobCookie);
    expect(res.status).toBe(201);

    // Alice trying to claim Bob's auto-linked participant -> 409,
    // which proves the join wrote userId + index for Bob.
    const conflict = await claimRoute(
      req("http://t/x", {
        method: "POST",
        headers: { cookie: `${participantCookie}; ${aliceCookie}` },
      }),
      slugParams(slug),
    );
    expect(conflict.status).toBe(409);

    // Bob's own claim is the idempotent same-user path.
    const own = await claimRoute(
      req("http://t/x", {
        method: "POST",
        headers: { cookie: `${participantCookie}; ${bobCookie}` },
      }),
      slugParams(slug),
    );
    expect(own.status).toBe(200);
    expect((await own.json()).userId).toBe("synthetic-bob");
  });

  it("restore: user cookie alone re-enters as the claimed participant (new device)", async () => {
    const aliceCookie = await signIn("token-alice");
    const slug = await makeBoard("Restore board");
    // Device A: join while signed in (auto-claims + writes index).
    const { res, participantCookie } = await join(slug, "Aye", aliceCookie);
    expect(res.status).toBe(201);
    const joined = (await res.clone().json()) as {
      participant: { id: string };
    };

    // Device B: only the user cookie, no participant cookie.
    const restored = await boardGetRoute(
      req("http://t/x", { headers: { cookie: aliceCookie } }),
      slugParams(slug),
    );
    expect(restored.status).toBe(200);
    const setCookie = restored.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    const view = (await restored.json()) as {
      me: { id: string; displayName: string } | null;
    };
    expect(view.me?.id).toBe(joined.participant.id);
    expect(view.me?.displayName).toBe("Aye");

    // The restored cookie actually works as the participant session.
    const restoredCookie = cookiePair(restored);
    const again = await boardGetRoute(
      req("http://t/x", { headers: { cookie: restoredCookie } }),
      slugParams(slug),
    );
    expect(((await again.json()) as { me: unknown }).me).not.toBeNull();

    // Rotation revoked device A's cookie (documented single-hash limit).
    const oldDevice = await boardGetRoute(
      req("http://t/x", { headers: { cookie: participantCookie } }),
      slugParams(slug),
    );
    expect(((await oldDevice.json()) as { me: unknown }).me).toBeNull();

    // A signed-in stranger with no claim restores nobody, sets nothing.
    const bobCookie = await signIn("token-bob");
    const stranger = await boardGetRoute(
      req("http://t/x", { headers: { cookie: bobCookie } }),
      slugParams(slug),
    );
    expect(stranger.status).toBe(200);
    expect(stranger.headers.get("set-cookie")).toBeNull();
    expect(((await stranger.json()) as { me: unknown }).me).toBeNull();
  });

  it("auto-claim: opening a board signed in links an unclaimed participant", async () => {
    const aliceCookie = await signIn("token-alice");
    const bobCookie = await signIn("token-bob");
    const slug = await makeBoard("Auto-claim open board");

    // Joined while signed OUT: no claim yet.
    const { res, participantCookie } = await join(slug, "Cee");
    expect(res.status).toBe(201);

    // Bob could claim it before any board open as Alice? Prove the
    // open did it: first open as Alice (both cookies), then Bob 409s.
    const opened = await boardGetRoute(
      req("http://t/x", {
        headers: { cookie: `${participantCookie}; ${aliceCookie}` },
      }),
      slugParams(slug),
    );
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { me: unknown }).me).not.toBeNull();

    const conflict = await claimRoute(
      req("http://t/x", {
        method: "POST",
        headers: { cookie: `${participantCookie}; ${bobCookie}` },
      }),
      slugParams(slug),
    );
    expect(conflict.status).toBe(409);
  });

  it("GET /api/me/boards: 401 signed out; claimed boards newest claim first", async () => {
    const anon = await myBoardsRoute(req("http://t/api/me/boards"));
    expect(anon.status).toBe(401);

    const aliceCookie = await signIn("token-alice");
    const first = await makeBoard("First claimed");
    const second = await makeBoard("Second claimed");
    await join(first, "Aye", aliceCookie);
    await join(second, "Aye", aliceCookie);

    const res = await myBoardsRoute(
      req("http://t/api/me/boards", { headers: { cookie: aliceCookie } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      boards: { slug: string; title: string; myPinCount: number }[];
    };
    const mine = body.boards.filter((b) => [first, second].includes(b.slug));
    // Same-ms activity ties break on claimedAt then slug; both
    // boards must be present with the card shape.
    expect(mine.map((b) => b.slug).sort()).toEqual([first, second].sort());
    expect(mine[0]).toMatchObject({ myPinCount: 0 });
    expect(body.boards.every((b) => typeof b.title === "string")).toBe(true);
  });

  it("My pins (PIN-85): library list, owner thumbnail, pin-from-library + repeat", async () => {
    const aliceCookie = await signIn("token-alice");
    const bobCookie = await signIn("token-bob");
    const boardA = await makeBoard("Library source");
    const boardB = await makeBoard("Library target");

    const aliceA = await join(boardA, "Aye", aliceCookie);
    const aliceAId = ((await aliceA.res.clone().json()) as {
      participant: { id: string };
    }).participant.id;
    const aliceB = await join(boardB, "Aye", aliceCookie);
    const bobB = await join(boardB, "Bee", bobCookie);
    await seedElement(boardA, aliceAId);

    // Signed out -> 401; signed in -> the element with a title
    // label and no board slug anywhere in the payload.
    expect((await myElementsRoute(req("http://t/api/me/elements"))).status).toBe(401);
    const list = await myElementsRoute(
      req("http://t/api/me/elements", { headers: { cookie: aliceCookie } }),
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      elements: { elementId: string; sourceBoardTitle: string }[];
      total: number;
    };
    expect(listBody.total).toBe(1);
    expect(listBody.elements[0]).toMatchObject({
      elementId: "route-el-1",
      sourceBoardTitle: "Library source",
    });
    expect(JSON.stringify(listBody)).not.toContain(boardA);

    // Owner thumbnail ok; the other user and signed-out get 404.
    const imageParams = { params: Promise.resolve({ elementId: "route-el-1" }) };
    const own = await myElementImageRoute(
      req("http://t/x?kind=cutout", { headers: { cookie: aliceCookie } }),
      imageParams,
    );
    expect(own.status).toBe(200);
    expect(await own.text()).toBe("png-bytes");
    const other = await myElementImageRoute(
      req("http://t/x?kind=cutout", { headers: { cookie: bobCookie } }),
      imageParams,
    );
    expect(other.status).toBe(404);
    expect((await myElementImageRoute(req("http://t/x?kind=cutout"), imageParams)).status).toBe(404);

    // Pin onto board B as alice's B participant; repeat is friendly.
    const pinReq = (cookie: string) =>
      req("http://t/x", {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ elementId: "route-el-1" }),
      });
    const aliceOnB = `${aliceB.participantCookie}; ${aliceCookie}`;
    const pinned = await fromLibraryRoute(pinReq(aliceOnB), slugParams(boardB));
    expect(pinned.status).toBe(200);
    const pinnedBody = (await pinned.json()) as {
      alreadyPinned: boolean;
      elementId: string;
    };
    expect(pinnedBody.alreadyPinned).toBe(false);
    expect(pinnedBody.elementId).not.toBe("route-el-1"); // provenance copy
    const repeat = await fromLibraryRoute(pinReq(aliceOnB), slugParams(boardB));
    expect(((await repeat.json()) as { alreadyPinned: boolean }).alreadyPinned).toBe(true);

    // Bob cannot pin alice's element (uniform 404); no participant
    // cookie -> 401; no user session -> 401.
    const bobOnB = `${bobB.participantCookie}; ${bobCookie}`;
    expect((await fromLibraryRoute(pinReq(bobOnB), slugParams(boardB))).status).toBe(404);
    expect((await fromLibraryRoute(pinReq(aliceCookie), slugParams(boardB))).status).toBe(401);
    expect(
      (await fromLibraryRoute(pinReq(aliceB.participantCookie), slugParams(boardB))).status,
    ).toBe(401);
  });

  it("PIN-94: wrong-provider and revoked tokens are 401 with no cookie", async () => {
    for (const idToken of ["token-anon", "token-revoked"]) {
      const res = await postSession(sessionReq(idToken));
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("PIN-160: stale sign-in auto-links on join and open; claim and restore need fresh", async () => {
    const staleCookie = await signIn("token-alice-stale");
    const bobCookie = await signIn("token-bob");

    // Ordinary session reads are unaffected by freshness.
    const me = await getMe(req("http://t/api/me", { headers: { cookie: staleCookie } }));
    expect(me.status).toBe(200);
    expect((await me.json()).user.uid).toBe("synthetic-alice");

    // One board for every flow (board creation is rate-limited).
    const slug = await makeBoard("Stale auth board");
    const aye = await join(slug, "Aye");
    expect(aye.res.status).toBe(201);
    const ayeId = await participantIdOf(aye.res);
    const getView = (cookie: string) =>
      boardGetRoute(req("http://t/x", { headers: { cookie } }), slugParams(slug));

    // Explicit claim with the stale session -> 401 stale_auth.
    const staleClaim = await claimRoute(
      req("http://t/x", {
        method: "POST",
        headers: { cookie: `${aye.participantCookie}; ${staleCookie}` },
      }),
      slugParams(slug),
    );
    expect(staleClaim.status).toBe(401);
    expect((await staleClaim.json()).error).toBe("Sign in again to link this board.");
    expect((await linkState(slug, ayeId)).userId).toBeUndefined();

    // Board-open with the stale session links the unclaimed one.
    const opened = await getView(`${aye.participantCookie}; ${staleCookie}`);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("set-cookie")).toBeNull();
    expect(((await opened.json()) as { me: { id: string } | null }).me?.id).toBe(ayeId);
    expect(await linkState(slug, ayeId)).toEqual({
      userId: "synthetic-alice",
      indexed: ayeId,
    });

    // Bob's claim is never re-linked by stale alice's join or open.
    const bee = await join(slug, "Bee", bobCookie);
    const beeId = await participantIdOf(bee.res);
    const both = `${bee.participantCookie}; ${staleCookie}`;
    const rejoin = await join(slug, "Bee", both);
    expect(rejoin.res.status).toBe(200);
    expect((await getView(both)).status).toBe(200);
    expect((await linkState(slug, beeId)).userId).toBe("synthetic-bob");
    expect((await linkState(slug, ayeId)).indexed).toBe(ayeId);

    // The stale session alone restores nobody, sets nothing...
    const staleRestore = await getView(staleCookie);
    expect(staleRestore.status).toBe(200);
    expect(staleRestore.headers.get("set-cookie")).toBeNull();
    expect(((await staleRestore.json()) as { me: unknown }).me).toBeNull();

    // ...while a fresh session restores the linked participant.
    const freshRestore = await getView(await signIn("token-alice"));
    expect(freshRestore.headers.get("set-cookie")).not.toBeNull();
    expect(
      ((await freshRestore.json()) as { me: { id: string } | null }).me?.id,
    ).toBe(ayeId);

    // Join while stale links the new participant and the index
    // follows it, so the board is in My boards for that session.
    const cee = await join(slug, "Cee", staleCookie);
    expect(cee.res.status).toBe(201);
    const ceeId = await participantIdOf(cee.res);
    expect(await linkState(slug, ceeId)).toEqual({
      userId: "synthetic-alice",
      indexed: ceeId,
    });
    const myBoards = await myBoardsRoute(
      req("http://t/api/me/boards", { headers: { cookie: staleCookie } }),
    );
    const listed = (await myBoards.json()) as { boards: { slug: string }[] };
    expect(listed.boards.map((b) => b.slug)).toContain(slug);
  });

  it("PIN-160: join refuses cross-site (403) and non-JSON (415); nobody joins", async () => {
    const slug = await makeBoard("Join guard board", "192.0.2.160");
    const joinReq = (headers: Record<string, string>) =>
      joinRoute(
        req("http://t/x", {
          method: "POST",
          headers,
          body: JSON.stringify({ displayName: "Eve" }),
        }),
        slugParams(slug),
      );
    for (const site of ["cross-site", "same-site", "none"]) {
      const res = await joinReq({ "content-type": "application/json", "sec-fetch-site": site });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("cross_site");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    // A cross-site HTML form can only post text/plain.
    const form = await joinReq({ "content-type": "text/plain" });
    expect(form.status).toBe(415);
    expect((await form.json()).code).toBe("unsupported_media_type");
    expect(form.headers.get("set-cookie")).toBeNull();
    expect(await participantCount(slug)).toBe(0);
  });

  it("PIN-160: a cross-site board GET never links or restores; the view is served", async () => {
    const aliceCookie = await signIn("token-alice");
    const slug = await makeBoard("Cross-site open board", "192.0.2.161");
    const dee = await join(slug, "Dee"); // signed out: unclaimed
    const deeId = await participantIdOf(dee.res);
    const both = `${dee.participantCookie}; ${aliceCookie}`;
    const getView = (cookie: string, site: string) =>
      boardGetRoute(
        req("http://t/x", { headers: { cookie, "sec-fetch-site": site } }),
        slugParams(slug),
      );
    const meOf = async (res: Response) =>
      ((await res.json()) as { me: { id: string } | null }).me;

    // Both cookies, cross-site: the view, but no link.
    const crossOpen = await getView(both, "cross-site");
    expect(crossOpen.status).toBe(200);
    expect((await meOf(crossOpen))?.id).toBe(deeId);
    expect(await linkState(slug, deeId)).toEqual({});
    // The app's own same-origin poll links it.
    await getView(both, "same-origin");
    expect(await linkState(slug, deeId)).toEqual({
      userId: "synthetic-alice",
      indexed: deeId,
    });

    // User cookie alone with a live fresh claim: no restore cookie
    // cross-site...
    for (const site of ["cross-site", "same-site", "none"]) {
      const res = await getView(aliceCookie, site);
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await meOf(res)).toBeNull();
    }
    // ...while same-origin restores.
    const restored = await getView(aliceCookie, "same-origin");
    expect(restored.headers.get("set-cookie")).not.toBeNull();
    expect((await meOf(restored))?.id).toBe(deeId);
  });

  it("DELETE /api/auth/session clears the cookie; /api/me is then 401", async () => {
    const res = await deleteSession(
      req("http://t/api/auth/session", { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("pinned_user=;");
    expect(setCookie).toContain("Max-Age=0");

    const cleared = cookiePair(res);
    const me = await getMe(req("http://t/api/me", { headers: { cookie: cleared } }));
    expect(me.status).toBe(401);
  });
});
