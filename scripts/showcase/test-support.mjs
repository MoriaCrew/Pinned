/**
 * Shared helpers for the showcase script tests: a sample set spec and a
 * fake boards API (a local HTTP server) that the driver can run against.
 * Nothing here calls a model or leaves the machine.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

/** The cat set of the PIN-171 spike, with photo names instead of local paths. */
export const catSpec = () => ({
  id: "cat",
  title: "Showcase: cat (synthetic)",
  themeId: "paper",
  friends: [
    { name: "Aye", photo: "cat/aye.webp" },
    { name: "Ben", photo: "cat/ben.webp" },
    { name: "Kim", photo: "cat/kim.webp" },
  ],
  scenes: [
    {
      id: "c1-street",
      prompt: "The orange tabby cat wearing the green beanie and the red heart-shaped sunglasses, riding the skateboard down a sunny street. Low-angle action photo.",
      pick: [
        { friend: "Aye", match: "cat|tabby|kitten" },
        { friend: "Ben", match: "beanie|hat" },
        { friend: "Ben", match: "heart|sunglass|glasses" },
        { friend: "Kim", match: "skate|board" },
      ],
      names: ["cat", "beanie", "sunglasses", "skateboard"],
    },
  ],
});

/** A temp folder with the cat set's three photos in it (any bytes will do for the fake app). */
export function makeWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "showcase-test-"));
  const photosDir = path.join(root, "photos");
  mkdirSync(path.join(photosDir, "cat"), { recursive: true });
  for (const name of ["aye", "ben", "kim"]) writeFileSync(path.join(photosDir, "cat", `${name}.webp`), Buffer.from(`not-a-real-photo-${name}`));
  return { root, photosDir, outDir: path.join(root, "out", "cat") };
}

export const SLUG = "SECRETSLUGabcdef0123";
export const cookieFor = (name) => `COOKIEVALUE${name}0123456789`;

const ELEMENTS = {
  Aye: [{ label: "Ginger Tabby Cat", description: "An orange tabby cat sitting upright" }],
  Ben: [
    { label: "Green Beanie", description: "A knitted bright-green beanie" },
    { label: "Red Heart Sunglasses", description: "Heart-shaped red sunglasses" },
  ],
  Kim: [{ label: "Patterned Skateboard", description: "A skateboard with an orange and teal deck" }],
};

/**
 * A fake boards API. `plan`:
 *   photo[name]  statuses the friend's successive jobs end with (default ["ready"])
 *   scene        { status, kind } the scenes end with, one entry per attempt (the last repeats)
 *   sceneHttp    HTTP statuses the first scene requests answer with, before the normal answer
 *   mock         what /api/health says
 *   uploadError  make uploads answer 500 with a message that holds the slug
 * Returns { base, requests, close }.
 */
export async function startFakeApp(plan = {}) {
  const requests = [];
  const jobs = new Map();
  const photoCalls = {};
  let sceneCalls = 0;
  const scenes = new Map();
  const png = Buffer.from("89504e470d0a1a0a", "hex");

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const body = Buffer.concat(chunks);
      const json = (status, value, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(value));
      };
      const image = (type) => {
        res.writeHead(200, { "content-type": type });
        res.end(png);
      };
      const friend = Object.keys(ELEMENTS).find((n) => (req.headers.cookie ?? "").includes(cookieFor(n)));
      const route = `${req.method} ${url.pathname.replace(SLUG, ":slug")}`;
      requests.push({ route, search: url.search, body: body.toString("utf8").slice(0, 400) });

      if (route === "GET /api/health") return json(200, { ok: true, aiMock: plan.mock ?? false });
      if (route === "POST /api/boards") return json(201, { board: { slug: SLUG } });
      if (route === "POST /api/boards/:slug/participants") {
        const name = JSON.parse(body.toString()).displayName;
        return json(201, {}, { "set-cookie": [`pinned_session=${cookieFor(name)}; Path=/; HttpOnly`] });
      }
      if (route === "POST /api/boards/:slug/photos") {
        if (plan.uploadError) return json(500, { error: typeof plan.uploadError === "string" ? plan.uploadError : `Could not store the photo for board ${SLUG}` });
        photoCalls[friend] = (photoCalls[friend] ?? 0) + 1;
        const id = `job-${friend}-${photoCalls[friend]}`;
        jobs.set(id, { friend, status: (plan.photo?.[friend] ?? ["ready"])[photoCalls[friend] - 1] ?? "ready" });
        return json(201, { job: { id } });
      }
      const jobMatch = url.pathname.match(/\/jobs\/([\w-]+)$/);
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        const ready = job.status === "ready";
        const elements = ready ? ELEMENTS[job.friend].map((e, i) => ({ id: `el-${job.friend}-${i}`, ...e, maskBox: { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.8 }, faceFlag: false })) : [];
        return json(200, {
          job: { id: jobMatch[1], status: job.status, faceNote: null, ...(ready ? {} : { errorCode: "model_timeout" }) },
          pins: elements.map((e) => ({ id: `pin-${e.id}` })),
          elements,
        });
      }
      if (route === "POST /api/boards/:slug/pins/confirm") return json(200, {});
      if (url.pathname.includes("/elements/")) return image("image/png");
      if (route === "POST /api/boards/:slug/scenes") {
        const status = plan.sceneHttp?.[sceneCalls];
        if (status) {
          sceneCalls += 1;
          return json(status, { error: "busy" });
        }
        const wanted = plan.scene ?? [{ status: "ready", kind: "ai" }];
        const outcome = wanted[Math.min(sceneCalls, wanted.length - 1)];
        sceneCalls += 1;
        const scene = { id: `scene-${sceneCalls}`, status: outcome.status, kind: outcome.kind, promptVersion: "scene.v1", width: 1280, height: 1920, ...(outcome.status === "refused" ? { refusalReason: "policy" } : {}) };
        scenes.set(scene.id, scene);
        return json(201, { scene, job: { id: scene.id, status: scene.status } });
      }
      const sceneMatch = url.pathname.match(/\/scenes\/([\w-]+)(\/image)?$/);
      if (sceneMatch && sceneMatch[2]) return image("image/webp");
      if (sceneMatch) return json(200, { scene: scenes.get(sceneMatch[1]), job: null });
      return json(404, { error: "not found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
