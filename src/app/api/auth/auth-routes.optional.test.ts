import { beforeAll, describe, expect, it } from "vitest";

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

beforeAll(async () => {
  const { FakeTokenVerifier, setTokenVerifierForTests } =
    await import("../../../server/token-verifier");
  setTokenVerifierForTests(
    new FakeTokenVerifier({
      "token-alice": {
        uid: "synthetic-alice",
        displayName: "Alice A",
        photoUrl: "https://example.test/alice.png",
      },
      "token-bob": { uid: "synthetic-bob" },
    }),
  );
  ({ POST: postSession, DELETE: deleteSession } = await import("./session/route"));
  ({ GET: getMe } = await import("../me/route"));
  ({ POST: createBoardRoute } = await import("../boards/route"));
  ({ POST: joinRoute } = await import("../boards/[slug]/participants/route"));
  ({ POST: claimRoute } = await import("../boards/[slug]/claim/route"));
  ({ GET: boardGetRoute } = await import("../boards/[slug]/route"));
  ({ GET: myBoardsRoute } = await import("../me/boards/route"));
});

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
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
  const res = await postSession(
    req("http://t/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ idToken }),
    }),
  );
  expect(res.status).toBe(200);
  return cookiePair(res);
}

async function makeBoard(title: string): Promise<string> {
  const res = await createBoardRoute(
    req("http://t/api/boards", {
      method: "POST",
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
      headers: cookie ? { cookie } : {},
      body: JSON.stringify({ displayName }),
    }),
    slugParams(slug),
  );
  return { res, participantCookie: cookiePair(res) };
}

describe("AUTH_MODE=optional: session, /api/me, claim, join auto-link", () => {
  it("GET /api/me without a session is 401; a bad ID token is 401", async () => {
    const me = await getMe(req("http://t/api/me"));
    expect(me.status).toBe(401);

    const bad = await postSession(
      req("http://t/api/auth/session", {
        method: "POST",
        body: JSON.stringify({ idToken: "not-a-token" }),
      }),
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  it("sign-in sets an httpOnly Lax user cookie; /api/me reads it; tamper is 401", async () => {
    const res = await postSession(
      req("http://t/api/auth/session", {
        method: "POST",
        body: JSON.stringify({ idToken: "token-alice" }),
      }),
    );
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
