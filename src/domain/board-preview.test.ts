import { describe, expect, it } from "vitest";
import {
  buildBoardPreview,
  chooseShareAction,
  pickLatestPreviewScene,
  sceneShareFilename,
  type PreviewSceneLike,
} from "./board-preview";

function scene(
  id: string,
  createdAt: number,
  over: Partial<PreviewSceneLike> = {},
): PreviewSceneLike {
  return {
    id,
    status: "ready",
    imageRef: `scenes/${id}.png`,
    prompt: `prompt ${id}`,
    createdAt,
    ...over,
  };
}

describe("board preview picker (PIN-72)", () => {
  it("picks the latest ready non-hidden scene with a scenes/ image", () => {
    const scenes = [
      scene("old", 100),
      scene("newest-hidden", 400, { hidden: true }),
      scene("newest", 300),
      scene("cooking", 500, { status: "running", imageRef: undefined }),
    ];
    expect(pickLatestPreviewScene(scenes)?.id).toBe("newest");
  });

  it("never picks failed/refused/pending, imageless, or non-scenes/ refs", () => {
    const scenes = [
      scene("ok", 1),
      scene("failed", 9, { status: "failed" }),
      scene("refused", 9, { status: "refused" }),
      scene("pending", 9, { status: "pending" }),
      scene("no-ref", 9, { imageRef: undefined }),
      scene("tmp-ref", 9, { imageRef: "tmp/working.jpg" }),
      scene("element-ref", 9, { imageRef: "elements/cutout.png" }),
    ];
    expect(pickLatestPreviewScene(scenes)?.id).toBe("ok");
  });

  it("breaks createdAt ties on id, stably", () => {
    expect(pickLatestPreviewScene([scene("a", 5), scene("b", 5)])?.id).toBe("b");
    expect(pickLatestPreviewScene([scene("b", 5), scene("a", 5)])?.id).toBe("b");
  });

  it("returns null when nothing is previewable", () => {
    expect(pickLatestPreviewScene([])).toBeNull();
    expect(pickLatestPreviewScene([scene("h", 1, { hidden: true })])).toBeNull();
  });

  it("builds absolute scene preview URLs from the public origin", () => {
    const preview = buildBoardPreview({
      boardTitle: "Kitchen chaos",
      slug: "abc123",
      origin: "https://dev.example.com/",
      scenes: [scene("s1", 10), scene("s2", 20)],
      fallbackDescription: "A shared board",
    });
    expect(preview).toEqual({
      title: "Kitchen chaos",
      description: "prompt s2",
      pageUrl: "https://dev.example.com/g/abc123",
      imageUrl: "https://dev.example.com/api/boards/abc123/scenes/s2/image",
      sceneId: "s2",
    });
  });

  it("falls back to the branded card when no scene is previewable", () => {
    const preview = buildBoardPreview({
      boardTitle: "Fresh board",
      slug: "xyz789",
      origin: "https://dev.example.com",
      scenes: [scene("h", 1, { hidden: true })],
      fallbackDescription: "A shared board",
    });
    expect(preview.imageUrl).toBe("https://dev.example.com/og-card.png");
    expect(preview.description).toBe("A shared board");
    expect(preview.sceneId).toBeNull();
  });

  it("walks the share ladder: files, then url, then download", () => {
    expect(chooseShareAction({ canShareFiles: true, canShareUrl: true })).toBe("files");
    expect(chooseShareAction({ canShareFiles: false, canShareUrl: true })).toBe("url");
    expect(chooseShareAction({ canShareFiles: false, canShareUrl: false })).toBe("download");
  });

  it("names shared files from the scene id and content type", () => {
    expect(sceneShareFilename("s/1", "image/jpeg")).toBe("pinneds-scene-s-1.jpg");
    expect(sceneShareFilename("s1", "image/webp; x")).toBe("pinneds-scene-s1.webp");
    expect(sceneShareFilename("s1", "application/octet-stream")).toBe("pinneds-scene-s1.png");
  });
});
