import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * POST /api/boards with credits on (PIN-205): the route builds the
 * maker key — the signed-in user when sign-in is on, else the
 * client address — and a maker's boards past
 * credits.starterBoardsPerMaker start with no free creations.
 * Env is set BEFORE the route modules first read config, so the
 * handlers are imported in beforeAll (auth-routes.optional.test
 * pattern). Documentation addresses and synthetic uids only.
 */
const ENV_KEYS = ["AUTH_MODE", "SESSION_SECRET", "DATA_BACKEND", "POLICY_OVERRIDES_JSON"] as const;
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
process.env.AUTH_MODE = "optional";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-32";
process.env.DATA_BACKEND = "memory";
process.env.POLICY_OVERRIDES_JSON = JSON.stringify({
  credits: { enabled: true, starterMakes: 5, starterBoardsPerMaker: 1 },
});

type Handler = (request: Request) => Promise<Response>;
let createBoardRoute: Handler;
let postSession: Handler;
let storedStarter: (slug: string) => Promise<number | undefined>;
let available: (slug: string) => Promise<number>;

beforeAll(async () => {
  const { FakeTokenVerifier, setTokenVerifierForTests } = await import("../../../server/token-verifier");
  setTokenVerifierForTests(new FakeTokenVerifier({ "token-maker": { uid: "synthetic-maker" } }));
  ({ POST: createBoardRoute } = await import("./route"));
  ({ POST: postSession } = await import("../auth/session/route"));
  const { getBoardRepository } = await import("../../../server/board-repository");
  const { getCreditLedgerStore } = await import("../../../server/credit-ledger-store");
  storedStarter = async (slug) => (await getBoardRepository().getBoard(slug))?.starterMakes;
  available = async (slug) => (await getCreditLedgerStore().getBalance(slug)).available;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

async function createBoard(headers: Record<string, string>): Promise<string> {
  const res = await createBoardRoute(
    new Request("http://t/api/boards", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Family board" }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { board: { slug: string } }).board.slug;
}

async function signIn(ip: string): Promise<string> {
  const res = await postSession(
    new Request("http://t/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": ip },
      body: JSON.stringify({ idToken: "token-maker" }),
    }),
  );
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

describe("POST /api/boards with credits on (PIN-205)", () => {
  it("counts a signed-out maker by client address", async () => {
    const first = await createBoard({ "x-forwarded-for": "192.0.2.10" });
    expect(await storedStarter(first)).toBe(5);
    expect(await available(first)).toBe(5);

    const second = await createBoard({ "x-forwarded-for": "192.0.2.10" });
    expect(await storedStarter(second)).toBe(0);
    expect(await available(second)).toBe(0);

    const elsewhere = await createBoard({ "x-forwarded-for": "198.51.100.10" });
    expect(await available(elsewhere)).toBe(5);
  });

  it("counts a signed-in maker by account, not by the shared address", async () => {
    await createBoard({ "x-forwarded-for": "192.0.2.20" });
    const cookie = await signIn("192.0.2.21");
    const signedIn = await createBoard({ "x-forwarded-for": "192.0.2.20", cookie });
    expect(await available(signedIn)).toBe(5);
    const again = await createBoard({ "x-forwarded-for": "203.0.113.20", cookie });
    expect(await available(again)).toBe(0);
  });
});
