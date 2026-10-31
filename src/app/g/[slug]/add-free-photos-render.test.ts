import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FREE_PHOTOS_USED } from "../../../domain/free-photos";
import type { MyPinCard } from "../../../domain/my-pins";
import { LocaleProvider } from "../../../i18n/client";
import type { AuthContextValue } from "../../auth/AuthProvider";
import { AddSheet, type AddBatchStep } from "./AddSheet";
import type { BoardClientView } from "./BoardClient";
import type { MyPinsResponse } from "./LibraryPins";

// The Add sheet reads sign-in for its "From your other boards" strip
// (PIN-121); each test picks link-only or signed in.
const auth = vi.hoisted(() => {
  const linkOnly = {
    enabled: false,
    status: "signedOut",
    user: null,
    signInError: false,
    signIn: async () => {},
    signOut: async () => {},
  };
  return { linkOnly, value: linkOnly as unknown };
});
vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => auth.value }));

const noop = () => {};
/** The shipped Policy.credits.lowFreePhotosWarning. */
const LOW = 3;

const INVITE = "This board used its free photos. Get Plus for unlimited photos.";
const PLAIN = "This board used its free photos, so new photos can&#x27;t be added right now.";
const PLUS_ON = "This board has Plus now, so photos are unlimited. Try again.";
/** The server's own message, which the invitation replaces. */
const SERVER_LINE = "This board used its free photos.";

function view(credits: BoardClientView["credits"], plusActive = false): BoardClientView {
  return {
    board: { slug: "kitchen", title: "Kitchen" },
    me: { id: "p1", displayName: "Robin" },
    participants: [{ id: "p1", displayName: "Robin" }],
    elements: [],
    pins: [],
    scenes: [],
    activity: [],
    plus: { active: plusActive, mode: "mock" },
    ...(credits ? { credits } : {}),
  } as unknown as BoardClientView;
}

const libraryCard: MyPinCard = {
  elementId: "mug",
  label: "Teal mug",
  description: "",
  faceFlag: false,
  sourceBoardTitle: "Desk",
  imageUrl: "/api/me/elements/mug/image?kind=cutout",
  createdAt: 1,
};

function render(
  boardView: BoardClientView,
  {
    /** Buying can work (the board passes the Plus sheet button); false = billing off. */
    billing = true,
    batch = null as AddBatchStep | null,
    lowFreePhotosWarning = LOW,
    locale = "en" as "en" | "fr",
  } = {},
): string {
  const client = new QueryClient();
  client.setQueryData<MyPinsResponse>(["my-pins"], { elements: [libraryCard], total: 1, limit: 50 });
  const sheet = h(AddSheet, {
    slug: "kitchen",
    meId: "p1",
    boardView,
    uploadMaxPx: 1600,
    uploadJpegQuality: 0.85,
    jobPollIntervalMs: 1000,
    elementsPerPhotoMax: 8,
    libraryStripMax: 8,
    lowFreePhotosWarning,
    resumeJobId: batch ? "upload-1" : null,
    onAddMakes: billing ? noop : undefined,
    onPickFiles: noop,
    batch,
    onClose: noop,
  });
  const localized: ReactNode =
    locale === "en" ? sheet : h(LocaleProvider, { locale, enabled: ["en", locale], cookieMaxAgeSeconds: 1, children: sheet });
  return renderToStaticMarkup(h(QueryClientProvider, { client, children: localized }));
}

function stoppedStep(over: Partial<AddBatchStep> = {}): AddBatchStep {
  return {
    itemStatus: "stopped",
    previewUrl: null,
    errorCode: FREE_PHOTOS_USED,
    error: SERVER_LINE,
    index: 3,
    total: 4,
    states: ["done", "done", "stopped", "stopped"],
    droppedCount: 0,
    onConfirmed: noop,
    onSkip: noop,
    onRetry: noop,
    ...over,
  };
}

const PICKER = /type="file"/g;
const GET_PLUS = /<button type="button" class="pn-btn pn-btn-primary">Get Plus<\/button>/;

beforeEach(() => {
  auth.value = auth.linkOnly;
});

describe("free photos in the Add sheet (PIN-231)", () => {
  it("says nothing while plenty are left, with Plus, or with credits off", () => {
    for (const boardView of [view({ availableMakes: 5, freePhotosLeft: 15 }), view({ availableMakes: 5, freePhotosLeft: 4 }), view({ availableMakes: 5 }, true), view(undefined)]) {
      const out = render(boardView);
      expect(out.match(PICKER)).toHaveLength(2);
      expect(out).not.toMatch(/free photo/i);
      expect(out).not.toContain("Get Plus");
    }
  });

  it("goes quiet-low at the Policy threshold: one status line under the picker, no button", () => {
    const out = render(view({ availableMakes: 5, freePhotosLeft: 3 }));
    expect(out).toContain('<p class="pn-add-help" role="status">3 free photos left on this board</p>');
    expect(out.match(PICKER)).toHaveLength(2);
    expect(out.indexOf("Choose photo")).toBeLessThan(out.indexOf("3 free photos left"));
    expect(out).not.toContain("Get Plus");
    expect(out).not.toContain('role="alert"');
    expect(render(view({ availableMakes: 5, freePhotosLeft: 1 }))).toContain("1 free photo left on this board");
    // A threshold of 0 turns the line off.
    expect(render(view({ availableMakes: 5, freePhotosLeft: 1 }), { lowFreePhotosWarning: 0 })).not.toMatch(/free photo/);
  });

  it("at 0, invites to Plus instead of showing the picker, never as an error", () => {
    const out = render(view({ availableMakes: 5, freePhotosLeft: 0 }));
    expect(out).toContain(INVITE);
    expect(out).toMatch(GET_PLUS);
    expect(out).not.toMatch(PICKER);
    expect(out).not.toContain("Take photo");
    expect(out).not.toContain('role="alert"');
    expect(out).toMatch(/<p class="pn-add-line" role="status">/);
    // Even with the low line switched off.
    expect(render(view({ availableMakes: 5, freePhotosLeft: 0 }), { lowFreePhotosWarning: 0 })).toContain(INVITE);
  });

  it("at 0 with billing off, keeps the plain fact and no button", () => {
    const out = render(view({ availableMakes: 5, freePhotosLeft: 0 }), { billing: false });
    expect(out).toContain(PLAIN);
    expect(out).not.toContain("Get Plus");
    expect(out).not.toContain("pn-btn-primary");
    expect(out).not.toMatch(PICKER);
    expect(out).not.toContain('role="alert"');
  });

  it("at 0, keeps From your other boards: library pins use no AI and no free photo", () => {
    auth.value = { ...auth.linkOnly, enabled: true, status: "signedIn", user: { uid: "u1", displayName: "Robin", photoUrl: null } } satisfies AuthContextValue;
    const out = render(view({ availableMakes: 5, freePhotosLeft: 0 }));
    expect(out).toContain(INVITE);
    expect(out).toContain("From your other boards");
    expect(out).toContain('aria-label="Pin here: Teal mug"');
    expect(out.indexOf(INVITE)).toBeLessThan(out.indexOf("From your other boards"));
  });

  it("a batch photo stopped at the limit shows the invitation instead of the error, once", () => {
    const out = render(view({ availableMakes: 5, freePhotosLeft: 0 }), { batch: stoppedStep() });
    expect(out.split(INVITE)).toHaveLength(2);
    expect(out).toMatch(GET_PLUS);
    expect(out).not.toContain(`${SERVER_LINE}<`);
    expect(out).not.toContain('role="alert"');
    // The step keeps its way on: try again (after Plus) or skip it.
    expect(out).toContain("Photo 3 of 4");
    expect(out).toContain("Skip");
    expect(out).not.toMatch(PICKER);
  });

  it("a stopped batch photo with billing off keeps the plain fact; with Plus since, says the limit is gone", () => {
    const off = render(view({ availableMakes: 5, freePhotosLeft: 0 }), { batch: stoppedStep(), billing: false });
    expect(off).toContain(PLAIN);
    expect(off).not.toContain("Get Plus");
    const plus = render(view({ availableMakes: 25 }, true), { batch: stoppedStep() });
    expect(plus).toContain(PLUS_ON);
    expect(plus).not.toContain("Get Plus");
    expect(plus).not.toContain(INVITE);
  });

  it("leaves the other stops alone: the empty pool and plain failures keep their own lines", () => {
    const pool = render(view({ availableMakes: 0, freePhotosLeft: 5 }), {
      batch: stoppedStep({ errorCode: "credits_pool_empty", error: "out" }),
    });
    expect(pool).toContain("This board is out of creations. Get Plus to keep going.");
    expect(pool).not.toContain(INVITE);
    const daily = render(view({ availableMakes: 5, freePhotosLeft: 5 }), {
      batch: stoppedStep({ errorCode: "photos_per_day", error: "That's all the photos for today." }),
    });
    expect(daily).toContain('role="alert"');
    expect(daily).toContain("That&#x27;s all the photos for today.");
    expect(daily).not.toContain(INVITE);
  });

  it("falls back to English in a language that has not translated it yet (docs/18)", () => {
    const low = render(view({ availableMakes: 5, freePhotosLeft: 2 }), { locale: "fr" });
    expect(low).toContain("2 free photos left on this board");
    const used = render(view({ availableMakes: 5, freePhotosLeft: 0 }), { locale: "fr" });
    expect(used).toContain(INVITE);
    expect(used).toContain("Prendre Plus");
  });
});

describe("free photos wiring guards (PIN-231)", () => {
  const read = (name: string) => readFileSync(path.join(process.cwd(), "src/app/g/[slug]", name), "utf8");

  it("turns a single upload's 429 free_photos_used into the same invitation, never the generic error", () => {
    const sheet = read("AddSheet.tsx");
    expect(sheet).toContain("if (!response.ok && isFreePhotosUsedCode(data.code)) setUploadFreePhotosUsed(true);");
    expect(sheet).toContain('uploadHitLimit: uploadFreePhotosUsed && uploadError !== ""');
    // The error line yields to the invitation in the picker's place.
    expect(sheet).toMatch(/uploadFreePhotosUsed \? \(\s*\/\/[^\n]*\n\s*pickView\.kind === "freePhotosUsed" \? null : freePhotosUsed/);
  });

  it("gives the sheet the Policy threshold and the Plus sheet button", () => {
    const board = read("BoardClient.tsx");
    expect(board).toContain("lowFreePhotosWarning={policy.makes?.lowFreePhotosWarning ?? 0}");
    expect(read("page.tsx")).toContain("lowFreePhotosWarning: resolved.credits.lowFreePhotosWarning");
    expect(board).toMatch(/onAddMakes=\{\s*makes\.canBuy && view\.credits/);
  });
});
