import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderSheet, writeSheet } from "./sheet.mjs";

const run = () => ({
  schema: 1,
  set: "cat",
  title: "Showcase: cat (synthetic)",
  mock: false,
  jobs: 4,
  totalMs: 61_000,
  models: { spark: "muse-spark-1.3", sam: "sam-3.1", image: "muse-image-1.0" },
  promptVersions: { elements: "elements.v1", scene: "scene.v1" },
  friends: [
    {
      name: "Aye",
      photoFile: "photos/aye.webp",
      status: "ready",
      faceNote: null,
      attempts: [{ status: "ready", errorCode: null, ms: 13_200 }],
      elements: [{ label: "Ginger Tabby Cat", description: "", maskBox: { x1: 0.1, y1: 0.2, x2: 0.6, y2: 0.9 }, faceFlag: false, files: { cutout: "aye-0-ginger-tabby-cat-cutout.png", flat: "aye-0-ginger-tabby-cat-flat.png" } }],
    },
  ],
  scenes: [
    {
      id: "c1-street",
      prompt: "The cat rides a skateboard.",
      picked: [{ friend: "Aye", label: "Ginger Tabby Cat" }],
      attempts: [{ status: "ready", kind: "ai", ms: 15_900 }],
      status: "ready",
      kind: "ai",
      promptVersion: "scene.v1",
      file: "scene-c1-street.webp",
    },
  ],
  failures: [],
});

describe("renderSheet", () => {
  it("shows the photo with its mask box and label, the cut-out and the scene", () => {
    const html = renderSheet(run());
    expect(html).toContain('<img src="photos/aye.webp"');
    expect(html).toContain("left:10.00%;top:20.00%;width:50.00%;height:70.00%");
    expect(html).toContain("<b>Ginger Tabby Cat</b>");
    expect(html).toContain('<img src="aye-0-ginger-tabby-cat-cutout.png"');
    expect(html).toContain("drop-shadow(3px 0 0 var(--keyline))");
    expect(html).toContain('<img src="scene-c1-street.webp"');
    expect(html).toContain("scene.v1");
    expect(html).toContain("muse-image-1.0");
    expect(html).toContain("live run");
  });

  it("escapes what a model or a spec wrote", () => {
    const record = run();
    record.friends[0].elements[0].label = '<img src=x onerror="alert(1)">';
    record.friends[0].elements[0].files.cutout = 'a"b c.png';
    record.scenes[0].prompt = "<script>alert(1)</script>";
    record.failures = ["<b>boom</b>"];
    const html = renderSheet(record);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>boom</b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain('src="a%22b%20c.png"');
  });

  it("lists failures and marks a mock run", () => {
    const record = run();
    record.mock = true;
    record.failures = ["Kim: no usable pin"];
    const html = renderSheet(record);
    expect(html).toContain("<li>Kim: no usable pin</li>");
    expect(html).toContain("MOCK run (collages expected)");
  });

  it("needs no network", () => {
    expect(renderSheet(run())).not.toMatch(/https?:\/\//);
  });

  it("writes contact-sheet.html next to run.json", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "showcase-sheet-"));
    const file = writeSheet(run(), dir);
    expect(path.basename(file)).toBe("contact-sheet.html");
    expect(readFileSync(file, "utf8")).toContain("<!doctype html>");
  });
});
