/**
 * PIN-41: regenerate preset illustrations with Higgsfield and bake
 * them into public/presets/<id>.webp (512px). Run manually, never
 * in CI: node scripts/bake-presets.mjs [presetId ...]
 *
 * Credentials (server-side only, never commit): HF_API_KEY_ID and
 * HF_API_KEY_SECRET, read from the environment or .env.local.
 * Model: Recraft V4.1 Utility text-to-image (flat illustration,
 * palette/background control). One shared style line keeps the
 * set consistent. Review every output before committing —
 * illustrated characters only, never photoreal people.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import sharp from "sharp";

const SUBJECTS = {
  helpdesk: "a deadpan IT helpdesk worker wearing a telephone headset, holding a coffee mug, unimpressed expression, computer monitor behind",
  gran: "an unimpressed grandmother with glasses on a chain and knitted cardigan, arms folded, raised eyebrow",
  commentator: "an excited sports commentator with a microphone and headphones, mid-shout, stadium lights behind",
  chef: "a dramatic chef in a tall white hat holding a tasting spoon with a disdainful expression, steam swirls",
  pirate: "a cheerful pirate captain with a tricorn hat and a parrot on the shoulder, treasure map rolled under one arm",
  detective: "a noir detective in a trench coat and fedora holding a magnifying glass, suspicious squint",
  cat: "a smug orange cat sitting upright like royalty on a cushion, one paw raised, judging expression",
  astronaut: "an astronaut in a white spacesuit with the helmet visor up, giving a thumbs up, stars and a small planet behind",
};
const STYLE =
  "Flat vector storybook illustration, bold simple shapes, thick dark outline, playful expressive character, warm cream background, portrait bust composition, no text, no words, no letters, no watermark";

function credentials() {
  const fromEnv = process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET
    ? `${process.env.HF_API_KEY_ID}:${process.env.HF_API_KEY_SECRET}`
    : null;
  if (fromEnv) return fromEnv;
  const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const read = (name) => text.split(/\r?\n/).find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
  const id = read("HF_API_KEY_ID");
  const secret = read("HF_API_KEY_SECRET");
  if (id && secret) return `${id}:${secret}`;
  throw new Error("Set HF_API_KEY_ID and HF_API_KEY_SECRET (env or .env.local).");
}

async function generate(creds, id) {
  const res = await fetch("https://api.higgsfield.ai/recraft/v4.1/utility/text-to-image", {
    method: "POST",
    headers: { Authorization: `Key ${creds}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({
      prompt: `${STYLE}: ${SUBJECTS[id]}`,
      resolution: "1k",
      aspect_ratio: "1:1",
      output_format: "png",
      background_color: { rgb: [250, 246, 236] },
    }),
  });
  if (!res.ok) throw new Error(`${id}: submit ${res.status} ${await res.text()}`);
  const { request_id } = await res.json();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await fetch(`https://api.higgsfield.ai/requests/${request_id}/status`, {
      headers: { Authorization: `Key ${creds}` },
    });
    const body = await s.json();
    if (body.status === "completed") {
      const img = await fetch(body.images[0].url);
      return Buffer.from(await img.arrayBuffer());
    }
    if (["failed", "nsfw", "canceled"].includes(body.status)) throw new Error(`${id}: ${body.status}`);
  }
  throw new Error(`${id}: polling timed out`);
}

const creds = credentials();
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SUBJECTS);
const outDir = path.join(process.cwd(), "public", "presets");
mkdirSync(outDir, { recursive: true });
for (const id of ids) {
  if (!SUBJECTS[id]) throw new Error(`unknown preset ${id}`);
  const png = await generate(creds, id);
  const out = path.join(outDir, `${id}.webp`);
  await sharp(png).resize(512, 512).webp({ quality: 82 }).toFile(out);
  console.log(id, "->", out);
}
