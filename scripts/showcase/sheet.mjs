/**
 * Contact sheet for one showcase set (PIN-173, docs/17 step 5): a single
 * self-contained HTML page next to run.json. It shows each photo with the
 * mask boxes and labels the app found, every cut-out on the Paper
 * background with the sticker keyline (the CSS of `.pn-sticker img` in
 * src/ui/pinneds.css), and every scene with its status.
 *
 * Labels, descriptions and prompts come from a model or a spec, so every
 * string is escaped. The page loads nothing from the network.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A relative file path as a URL: each part encoded, slashes kept. */
const src = (file) => file.split("/").map(encodeURIComponent).join("/");

const pct = (n) => `${(Math.min(Math.max(Number(n) || 0, 0), 1) * 100).toFixed(2)}%`;

const CSS = `
:root { --surface: #f3efe6; --raised: #fffdf8; --ink: #1a1611; --muted: #5f574a; --line: #ddd5c6; --accent: #b8300f; --keyline: #fff; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: var(--surface); color: var(--ink); font: 15px/1.45 system-ui, sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 22px; } h2 { margin: 28px 0 8px; font-size: 17px; }
.meta { color: var(--muted); margin: 0 0 12px; } .fail { color: var(--accent); font-weight: 600; }
.row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.photo { position: relative; width: 240px; margin: 0; background: var(--raised); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
.frame { position: relative; line-height: 0; } .frame img { width: 100%; height: auto; display: block; border-radius: 4px; }
.box { position: absolute; border: 2px solid var(--accent); border-radius: 2px; }
.box b { position: absolute; left: -2px; top: 0; transform: translateY(-100%); background: var(--accent); color: #fff; font: 600 11px/1.3 system-ui, sans-serif; padding: 1px 4px; white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
figcaption { line-height: 1.35; margin-top: 8px; font-size: 13px; color: var(--muted); }
.cut { margin: 0; width: 150px; text-align: center; }
.cut .pad { height: 170px; display: grid; place-items: center; background: var(--surface); border: 1px dashed var(--line); border-radius: 8px; }
.cut img { max-width: 130px; max-height: 150px; object-fit: contain;
  filter: drop-shadow(3px 0 0 var(--keyline)) drop-shadow(-3px 0 0 var(--keyline)) drop-shadow(0 3px 0 var(--keyline)) drop-shadow(0 -3px 0 var(--keyline)) drop-shadow(0 4px 4px rgba(40, 28, 12, .32)); }
.scene { width: 300px; margin: 0; background: var(--raised); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
.scene img { width: 100%; height: auto; display: block; border-radius: 4px; }
`;

/** The contact sheet's HTML for a run record. */
export function renderSheet(run) {
  const photos = run.friends
    .map((f) => {
      const boxes = f.elements
        .map((e) => `<span class="box" style="left:${pct(e.maskBox?.x1)};top:${pct(e.maskBox?.y1)};width:${pct((e.maskBox?.x2 ?? 0) - (e.maskBox?.x1 ?? 0))};height:${pct((e.maskBox?.y2 ?? 0) - (e.maskBox?.y1 ?? 0))}"><b>${escapeHtml(e.label)}</b></span>`)
        .join("");
      const attempts = f.attempts.map((a) => `${a.status}${a.errorCode ? ` ${escapeHtml(a.errorCode)}` : ""} ${(a.ms / 1000).toFixed(1)}s`).join(", ");
      return `<figure class="photo"><div class="frame"><img src="${escapeHtml(src(f.photoFile))}" alt="${escapeHtml(f.name)}'s photo">${boxes}</div>
<figcaption><strong>${escapeHtml(f.name)}</strong> - ${escapeHtml(f.status)} (${attempts || "no job"})${f.faceNote ? `<br>face note: ${escapeHtml(f.faceNote)}` : ""}</figcaption></figure>`;
    })
    .join("\n");

  const cutouts = run.friends
    .flatMap((f) => f.elements.map((e) => ({ friend: f.name, ...e })))
    .map(
      (e) => `<figure class="cut"><div class="pad"><img src="${escapeHtml(src(e.files.cutout))}" alt="${escapeHtml(e.label)}"></div>
<figcaption>${escapeHtml(e.label)}<br>${escapeHtml(e.friend)}${e.faceFlag ? " - face" : ""}</figcaption></figure>`,
    )
    .join("\n");

  const scenes = run.scenes
    .map((s) => {
      const picked = s.picked.map((p) => `${escapeHtml(p.friend)}: ${escapeHtml(p.label)}`).join(" + ");
      const tries = s.attempts.map((a) => `${a.status}${a.kind ? `/${a.kind}` : ""} ${(a.ms / 1000).toFixed(1)}s`).join(", ");
      return `<figure class="scene">${s.file ? `<img src="${escapeHtml(src(s.file))}" alt="${escapeHtml(s.id)}">` : ""}
<figcaption><strong>${escapeHtml(s.id)}</strong> - ${escapeHtml(s.status)}${s.kind ? ` (${escapeHtml(s.kind)})` : ""}${s.promptVersion ? `, ${escapeHtml(s.promptVersion)}` : ""}<br>${tries ? `tries: ${tries}<br>` : ""}pins: ${picked || "none"}<br>${escapeHtml(s.prompt)}</figcaption></figure>`;
    })
    .join("\n");

  const failures = run.failures.length
    ? `<ul class="fail">${run.failures.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`
    : "";
  const models = Object.entries(run.models ?? {}).map(([k, v]) => `${escapeHtml(k)} ${escapeHtml(v)}`).join(", ");
  const versions = Object.values(run.promptVersions ?? {}).filter(Boolean).map(escapeHtml).join(", ");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(run.set)} contact sheet</title><style>${CSS}</style></head>
<body><main>
<h1>${escapeHtml(run.title)}</h1>
<p class="meta">set ${escapeHtml(run.set)} - ${run.mock ? "MOCK run (collages expected)" : "live run"} - ${run.jobs} model jobs - ${((run.totalMs ?? 0) / 1000).toFixed(0)} s - models: ${models} - prompts: ${versions || "unknown"}</p>
${failures}
<h2>Photos, with the mask boxes the app found</h2><div class="row">${photos}</div>
<h2>Cut-outs on Paper, with the sticker keyline</h2><div class="row">${cutouts}</div>
<h2>Scenes</h2><div class="row">${scenes || "<p class=\"meta\">No scenes in this set.</p>"}</div>
</main></body></html>
`;
}

/** Write contact-sheet.html next to run.json and return its path. */
export function writeSheet(run, outDir) {
  const file = path.join(outDir, "contact-sheet.html");
  writeFileSync(file, renderSheet(run));
  return file;
}
