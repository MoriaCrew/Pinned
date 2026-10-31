import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODELS, assertLocalBase, cookieHeader, latestPromptVersion, makeRedactor, modelsFromEnv, readHealth, runSet, slugify } from "./driver.mjs";
import { JobBudget } from "./spec.mjs";
import { SLUG, catSpec, cookieFor, makeWorkspace, startFakeApp } from "./test-support.mjs";

describe("assertLocalBase", () => {
  it("allows the local app only", () => {
    expect(assertLocalBase("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(assertLocalBase("http://127.0.0.1:3100")).toBe("http://127.0.0.1:3100");
    expect(assertLocalBase("http://[::1]:3000")).toBe("http://[::1]:3000");
    for (const url of ["https://localhost:3000", "http://example.com", "http://localhost.evil.com", "http://localhost@evil.com", "http://evil.com/localhost", "http://192.168.1.5:3000", "ftp://localhost"]) {
      expect(() => assertLocalBase(url), url).toThrow("the base URL must be http://localhost");
    }
  });

  it("allows another origin only when asked, and never one with credentials or a path", () => {
    expect(assertLocalBase("https://dev.example.com", { allowRemote: true })).toBe("https://dev.example.com");
    expect(() => assertLocalBase("https://user:pw@dev.example.com", { allowRemote: true })).toThrow();
    expect(() => assertLocalBase("https://dev.example.com/api", { allowRemote: true })).toThrow();
  });
});

describe("small helpers", () => {
  it("redacts every known secret", () => {
    const secrets = ["slug-1234567"];
    const redact = makeRedactor(secrets);
    expect(redact("board slug-1234567 failed")).toBe("board [redacted] failed");
    secrets.push("cookie-abcdef");
    expect(redact("slug-1234567 / cookie-abcdef / slug-1234567")).toBe("[redacted] / [redacted] / [redacted]");
  });

  it("builds a cookie header, file slugs, prompt versions and model ids", () => {
    expect(cookieHeader(["a=1; Path=/; HttpOnly", "b=2; Path=/"])).toBe("a=1; b=2");
    expect(slugify("Red Heart-Shaped Sunglasses!")).toBe("red-heart-shaped-sunglasses");
    expect(slugify("???")).toBe("thing");
    expect(latestPromptVersion(["elements.v1.md", "elements.v2.md", "scene.v1.md", "README.md"], "elements")).toBe("elements.v2");
    expect(latestPromptVersion(["scene.v1.md"], "elements")).toBeNull();
    expect(modelsFromEnv({})).toEqual(DEFAULT_MODELS);
    expect(modelsFromEnv({ META_MODEL_IMAGE: "muse-image-2" }).image).toBe("muse-image-2");
  });

  it("uses the model ids the app defaults to (src/config.ts)", () => {
    const config = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/config.ts"), "utf8");
    const block = config.match(/DEFAULT_META_MODELS = \{([^}]*)\}/)[1];
    for (const [key, value] of Object.entries(DEFAULT_MODELS)) expect(block).toContain(`${key}: "${value}"`);
  });
});

describe("runSet against a fake app", () => {
  let app;
  let work;
  let logs;
  beforeEach(() => {
    work = makeWorkspace();
    logs = [];
  });
  afterEach(async () => {
    await app?.close();
  });

  const run = (spec = catSpec(), extra = {}) =>
    runSet(spec, {
      base: app.base,
      photosDir: work.photosDir,
      outDir: work.outDir,
      budget: new JobBudget(20),
      sceneTries: 3,
      mock: false,
      log: (line) => logs.push(line),
      models: DEFAULT_MODELS,
      promptVersions: { elements: "elements.v1", scene: null },
      sleep: async () => {},
      pollMs: 0,
      timeoutMs: 5000,
      ...extra,
    });
  const sceneRequests = () => app.requests.filter((r) => r.route === "POST /api/boards/:slug/scenes");

  it("drives a whole set and writes the run record and the downloads", async () => {
    app = await startFakeApp();
    const { run: record, failures } = await run();

    expect(failures).toEqual([]);
    expect(record.jobs).toBe(4); // 3 photos + 1 scene
    expect(record.friends.map((f) => [f.name, f.status, f.elements.map((e) => e.label)])).toEqual([
      ["Aye", "ready", ["Ginger Tabby Cat"]],
      ["Ben", "ready", ["Green Beanie", "Red Heart Sunglasses"]],
      ["Kim", "ready", ["Patterned Skateboard"]],
    ]);
    expect(record.friends[1].elements[0]).toMatchObject({ maskBox: { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.8 }, faceFlag: false, files: { cutout: "ben-0-green-beanie-cutout.png", flat: "ben-0-green-beanie-flat.png" } });
    expect(record.scenes[0]).toMatchObject({ id: "c1-street", status: "ready", kind: "ai", promptVersion: "scene.v1", width: 1280, height: 1920, file: "scene-c1-street.webp" });
    expect(record.promptVersions).toEqual({ elements: "elements.v1", scene: "scene.v1" });
    expect(readdirSync(work.outDir).sort()).toContain("scene-c1-street.webp");
    expect(existsSync(path.join(work.outDir, "photos", "ben.webp"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(work.outDir, "run.json"), "utf8")).set).toBe("cat");
  });

  it("sends the picked things to the scene in pick order", async () => {
    app = await startFakeApp();
    await run();
    const body = JSON.parse(sceneRequests()[0].body);
    expect(body.elementIds).toEqual(["el-Aye-0", "el-Ben-0", "el-Ben-1", "el-Kim-0"]);
    expect(body.prompt).toContain("riding the skateboard");
  });

  it("never prints or saves the board slug or a session cookie", async () => {
    app = await startFakeApp({ uploadError: true });
    const { run: record } = await run();
    const everything = [...logs, JSON.stringify(record), readFileSync(path.join(work.outDir, "run.json"), "utf8")].join("\n");
    expect(everything).not.toContain(SLUG);
    for (const name of ["Aye", "Ben", "Kim"]) expect(everything).not.toContain(cookieFor(name));
    expect(logs.join("\n")).toContain("board created (slug withheld)");
    // The upload error carried the slug in its message; it came out redacted.
    expect(record.failures.join("\n")).toContain("[redacted]");
  });

  it("retries a failed photo once and records the error code", async () => {
    app = await startFakeApp({ photo: { Ben: ["failed", "ready"] } });
    const { run: record, failures } = await run();
    expect(failures).toEqual([]);
    expect(record.jobs).toBe(5);
    expect(record.friends[1].attempts).toMatchObject([
      { status: "failed", usable: false, errorCode: "model_timeout" },
      { status: "ready", usable: true, errorCode: null },
    ]);
  });

  it("fails loudly when a photo has no usable pin twice, and does not spend on the scene", async () => {
    app = await startFakeApp({ photo: { Kim: ["failed", "failed"] } });
    const { run: record, failures } = await run();
    expect(record.friends[2].status).toBe("failed");
    expect(failures).toEqual([expect.stringContaining("Kim: no usable pin from cat/kim.webp (model_timeout, model_timeout)"), expect.stringContaining("scene c1-street: no pin for Kim /skate|board/")]);
    expect(sceneRequests()).toHaveLength(0);
    expect(record.scenes[0].status).toBe("skipped");
  });

  it("fails after the scene tries are spent on refusals", async () => {
    app = await startFakeApp({ scene: [{ status: "refused", kind: "ai" }] });
    const { run: record, failures } = await run();
    expect(sceneRequests()).toHaveLength(3);
    expect(record.jobs).toBe(6);
    expect(record.scenes[0].attempts.map((a) => a.status)).toEqual(["refused", "refused", "refused"]);
    expect(failures).toEqual(["scene c1-street: refused (policy) after 3 tries"]);
  });

  it("takes a later try that works", async () => {
    app = await startFakeApp({ scene: [{ status: "refused", kind: "ai" }, { status: "ready", kind: "ai" }] });
    const { run: record, failures } = await run();
    expect(failures).toEqual([]);
    expect(record.scenes[0].attempts.map((a) => a.status)).toEqual(["refused", "ready"]);
  });

  it("rejects a collage from a live app, and accepts it from a mock one", async () => {
    app = await startFakeApp({ scene: [{ status: "ready", kind: "collage" }] });
    const live = await run();
    expect(live.failures).toEqual(["scene c1-street: came back as collage, not an AI scene after 3 tries"]);
    expect(live.run.scenes[0].file).toBeNull();

    work = makeWorkspace();
    const mock = await run(catSpec(), { mock: true });
    expect(mock.failures).toEqual([]);
    expect(mock.run).toMatchObject({ mock: true, scenes: [{ status: "ready", kind: "collage", file: "scene-c1-street.webp" }] });
  });

  it("stops at the job cap and still writes the run record", async () => {
    app = await startFakeApp();
    const { run: record, failures } = await run(catSpec(), { budget: new JobBudget(2) });
    expect(failures).toEqual([expect.stringContaining("job cap of 2 reached before the photo of Kim")]);
    expect(record.jobs).toBe(2);
    expect(existsSync(path.join(work.outDir, "run.json"))).toBe(true);
  });

  it("does not start when a photo is missing from the photos folder", async () => {
    app = await startFakeApp();
    const spec = catSpec();
    spec.friends[1].photo = "cat/missing.webp";
    await expect(run(spec)).rejects.toThrow("photos not found in the photos folder: cat/missing.webp");
    expect(app.requests).toHaveLength(0);
  });
});

describe("readHealth", () => {
  it("reports whether the app mocks its models", async () => {
    const app = await startFakeApp({ mock: true });
    expect(await readHealth(app.base)).toEqual({ aiMock: true });
    await app.close();
  });

  it("explains when the app is not running", async () => {
    await expect(readHealth("http://127.0.0.1:9")).rejects.toThrow("cannot reach the app");
  });
});
