import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_CAP, PHOTO_SIZES, detectImageType, findImage, generatePhotos, validatePhotoItems } from "./photos.mjs";

const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);
const KEY = "test-key-never-printed-0123456789";
const items = (...outs) => outs.map((out) => ({ out, size: "1536x1024", prompt: `Casual smartphone photo of ${out}` }));

describe("validatePhotoItems", () => {
  it("accepts a list of photos", () => {
    expect(validatePhotoItems(items("cat/aye.webp", "cat/ben.webp"))).toEqual([]);
    expect(PHOTO_SIZES).toContain("1024x1536");
    expect(DEFAULT_IMAGE_CAP).toBe(40);
  });

  it("rejects local paths, odd sizes, empty prompts and repeats", () => {
    const errors = validatePhotoItems([
      { out: "C:/photos/a.webp", size: "1536x1024", prompt: "x" },
      { out: "b.webp", size: "800x600", prompt: "x" },
      { out: "c.webp", size: "1024x1024", prompt: " " },
      { out: "c.webp", size: "1024x1024", prompt: "x" },
    ]);
    expect(errors).toEqual([
      expect.stringContaining("items[0]: out must be a relative"),
      expect.stringContaining("items[1]: size must be one of"),
      expect.stringContaining("items[2]: prompt must be 1 to 2000"),
      expect.stringContaining('items[3]: "c.webp" appears twice'),
    ]);
    expect(validatePhotoItems([])).toEqual(["the items file must be a list of photos"]);
  });
});

describe("image helpers", () => {
  it("reads the real type from the first bytes", () => {
    expect(detectImageType(webp)).toBe(".webp");
    expect(detectImageType(Buffer.from("89504e470d0a1a0a00", "hex"))).toBe(".png");
    expect(detectImageType(Buffer.from("ffd8ffe000", "hex"))).toBe(".jpg");
    expect(detectImageType(Buffer.from("<html>not an image</html>"))).toBeNull();
  });

  it("finds an inline image or an https URL, however it is nested", () => {
    expect(findImage({ data: [{ b64_json: "AAAA" }] })).toEqual({ b64: "AAAA" });
    expect(findImage({ output: { items: [{ url: "https://cdn.example/x.webp" }] } })).toEqual({ url: "https://cdn.example/x.webp" });
    expect(findImage({ data: [{ url: "http://insecure.example/x" }] })).toBeNull();
    expect(findImage({ error: { message: "no" } })).toBeNull();
  });
});

describe("generatePhotos against a stub endpoint", () => {
  let server;
  afterEach(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

  async function stub(handler) {
    const seen = [];
    server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
        handler(res, seen.length);
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, seen };
  }
  const okImage = (res) => {
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "req-1" });
    res.end(JSON.stringify({ data: [{ b64_json: webp.toString("base64") }] }));
  };
  const setup = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "showcase-photos-"));
    return { photosDir: path.join(dir, "photos"), stateFile: path.join(dir, "state.json"), logs: [] };
  };

  it("makes each photo, saves it under its real type and counts it", async () => {
    const { baseUrl, seen } = await stub(okImage);
    const s = setup();
    const result = await generatePhotos(items("cat/aye.png", "cat/ben.webp"), { ...s, baseUrl, key: KEY, log: (l) => s.logs.push(l) });
    expect(result).toEqual({ made: [path.join("cat", "aye.webp"), path.join("cat", "ben.webp")], skipped: [], failed: [] });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/images/generations", auth: `Bearer ${KEY}`, body: { model: "muse-image-1.0", size: "1536x1024", n: 1 } });
    expect(readFileSync(path.join(s.photosDir, "cat", "aye.webp")).equals(webp)).toBe(true);
    const state = JSON.parse(readFileSync(s.stateFile, "utf8"));
    expect(state.generated).toBe(2);
    expect(state.log[0]).toMatchObject({ out: "aye.webp", model: "muse-image-1.0", size: "1536x1024", requestId: "req-1" });
    expect(s.logs.join("\n")).not.toContain(KEY);
    expect(s.logs.join("\n")).not.toContain("Casual smartphone photo");
  });

  it("stops before a call that would pass the image cap, counting the baseline", async () => {
    const { baseUrl, seen } = await stub(okImage);
    const s = setup();
    const result = await generatePhotos(items("a.webp", "b.webp", "c.webp"), { ...s, baseUrl, key: KEY, cap: 12, baseline: 10, log: (l) => s.logs.push(l) });
    expect(result.made).toEqual(["a.webp", "b.webp"]);
    expect(result.failed).toEqual(["c.webp"]);
    expect(seen).toHaveLength(2);
    expect(s.logs.at(-1)).toContain("image cap of 12 reached (12 generated)");
    // A second run starts from the saved count, not the baseline.
    const again = await generatePhotos(items("d.webp"), { ...s, baseUrl, key: KEY, cap: 12, baseline: 0, log: () => {} });
    expect(again.failed).toEqual(["d.webp"]);
    expect(seen).toHaveLength(2);
  });

  it("skips a photo that exists unless forced", async () => {
    const { baseUrl, seen } = await stub(okImage);
    const s = setup();
    await generatePhotos(items("a.webp"), { ...s, baseUrl, key: KEY, log: () => {} });
    const again = await generatePhotos(items("a.webp"), { ...s, baseUrl, key: KEY, log: () => {} });
    expect(again.skipped).toEqual(["a.webp"]);
    expect(seen).toHaveLength(1);
    const forced = await generatePhotos(items("a.webp"), { ...s, baseUrl, key: KEY, force: true, log: () => {} });
    expect(forced.made).toEqual(["a.webp"]);
    expect(JSON.parse(readFileSync(s.stateFile, "utf8")).generated).toBe(2);
  });

  it("reports a failed call without saving or counting it", async () => {
    const { baseUrl } = await stub((res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `secret detail ${KEY}` } }));
    });
    const s = setup();
    const result = await generatePhotos(items("a.webp"), { ...s, baseUrl, key: KEY, log: (l) => s.logs.push(l) });
    expect(result.failed).toEqual(["a.webp"]);
    expect(existsSync(path.join(s.photosDir, "a.webp"))).toBe(false);
    expect(existsSync(s.stateFile)).toBe(false);
    expect(s.logs.join("\n")).toContain("FAIL http=429");
    expect(s.logs.join("\n")).not.toContain("secret detail");
  });

  it("does not save an answer that is not an image, but still counts the paid call", async () => {
    const { baseUrl } = await stub((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: Buffer.from("<html>").toString("base64") }] }));
    });
    const s = setup();
    const result = await generatePhotos(items("a.webp"), { ...s, baseUrl, key: KEY, log: (l) => s.logs.push(l) });
    expect(result.failed).toEqual(["a.webp"]);
    expect(existsSync(path.join(s.photosDir, "a.webp"))).toBe(false);
    const state = JSON.parse(readFileSync(s.stateFile, "utf8"));
    expect(state.generated).toBe(1);
    expect(state.log[0]).toMatchObject({ out: "a.webp", failed: "the answer was not an image" });
  });

  it("carries on with the next photo when a picture URL cannot be fetched, and counts the paid call", async () => {
    const { baseUrl } = await stub((res, n) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [n === 1 ? { url: "https://cdn.example/dropped.webp" } : { b64_json: webp.toString("base64") }] }));
    });
    const s = setup();
    const fetchImpl = (url, init) => (String(url).startsWith("https://cdn.example") ? Promise.reject(new TypeError("fetch failed")) : fetch(url, init));
    const result = await generatePhotos(items("a.webp", "b.webp"), { ...s, baseUrl, key: KEY, fetchImpl, log: (l) => s.logs.push(l) });
    expect(result).toEqual({ made: ["b.webp"], skipped: [], failed: ["a.webp"] });
    const state = JSON.parse(readFileSync(s.stateFile, "utf8"));
    expect(state.generated).toBe(2);
    expect(state.log.map((e) => [e.out, e.failed ?? null])).toEqual([["a.webp", "could not fetch the picture"], ["b.webp", null]]);
    expect(s.logs.join("\n")).toContain("FAIL could not fetch the picture");
    expect(s.logs.join("\n")).not.toContain("cdn.example");
  });

  it("needs a key", async () => {
    const s = setup();
    writeFileSync(path.join(path.dirname(s.stateFile), "unused"), "");
    await expect(generatePhotos(items("a.webp"), { ...s, log: () => {} })).rejects.toThrow("META_API_KEY is missing");
  });
});
