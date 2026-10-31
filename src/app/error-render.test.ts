import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../i18n/messages/en.json";
import ErrorPage from "./error";
import GlobalError from "./global-error";

// error.tsx refreshes the route on retry; no router is mounted in a string render.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const secret = Object.assign(new Error("firestore exploded: projects/p/databases/(default)"), {
  digest: "3141592653",
});

const render = () =>
  renderToStaticMarkup(h(ErrorPage, { error: secret, reset: () => undefined }));

describe("error page (PIN-212)", () => {
  it("says it plainly in the kit's words, with a retry and a way home", () => {
    const out = render();
    expect(out).toContain("<h1");
    expect(out).toContain(en["error.pageTitle"]);
    expect(out).toContain(en["error.pageBody"].replace("'", "&#x27;"));
    expect(out).toMatch(/<button[^>]*class="pn-btn pn-btn-primary pn-btn-lg"[^>]*>.*Try again/);
    expect(out).toMatch(/<a[^>]*href="\/"[^>]*>Go home<\/a>/);
    expect(out).toContain('role="alert"');
  });

  it("wears the Paper skin like not-found and the library", () => {
    const out = render();
    expect(out).toContain('data-theme="paper"');
    expect(out).toContain("pn-skin-root pn-lib-page");
    expect(out).toContain("pn-empty-ghosts");
  });

  it("never shows the error's message, stack or digest", () => {
    const out = render();
    expect(out).not.toContain("firestore");
    expect(out).not.toContain("projects/p");
    expect(out).not.toContain("3141592653");
    expect(out).not.toMatch(/digest|stack|at .*\(.*:\d+:\d+\)/i);
  });
});

describe("global error page (PIN-212)", () => {
  it("brings its own <html> and <body> and the same screen, in English on the server", () => {
    const out = renderToStaticMarkup(h(GlobalError));
    expect(out).toContain('<html lang="en" data-theme="paper">');
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"/>');
    expect(out).toContain("<body><main");
    expect(out).toContain(en["error.pageTitle"]);
    expect(out).toContain("Try again");
    expect(out).toMatch(/<a[^>]*href="\/"[^>]*>Go home<\/a>/);
  });
});
