#!/usr/bin/env node
/**
 * PIN-3 live Meta Model API smoke test (manual, never in CI).
 *
 * Usage:
 *   1. Put META_API_KEY in .env.local (gitignored) or the environment.
 *   2. npm run smoke:meta [-- --image-url https://...]
 *
 * Without a key it verifies endpoint reachability only (expects the
 * OpenAI-style 401 invalid_api_key envelope) and exits 2.
 * With a key it runs, in order: GET /models, persona chat, Muse
 * Image generation, Spark vision judging on the generated (or given)
 * image, then SAM 3.1 segmentation via /responses. It prints shapes,
 * latencies and usage — never the key, never full image payloads.
 */
import { readFileSync, existsSync } from "node:fs";

function loadEnvLocal() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

loadEnvLocal();
const BASE = (process.env.META_API_BASE_URL || "https://api.meta.ai/v1").replace(/\/$/, "");
const KEY = process.env.META_API_KEY || "";
const SPARK = process.env.META_MODEL_SPARK || "muse-spark-1.3";
const SAM = process.env.META_MODEL_SAM || "sam-3.1";
const IMAGE = process.env.META_MODEL_IMAGE || "muse-image-1.0";
const argImage = (() => {
  const i = process.argv.indexOf("--image-url");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step} — ${detail}`);
}

async function call(step, path, init = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* shape reported by caller */
  }
  return { res, json, ms: Date.now() - started, rawLen: text.length };
}

function findImageRef(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") {
    return value.startsWith("data:image/") ? value.slice(0, 32) + "…" : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findImageRef(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && (k === "url" || k === "image_url") && /^https?:\/\//.test(v)) return v;
      if (typeof v === "string" && (k === "b64_json" || k === "base64")) return `base64(${v.length} chars)`;
      const hit = findImageRef(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function imageFormatFromBase64(payload, preferred) {
  if (payload.startsWith("/9j/")) return "jpeg";
  if (payload.startsWith("iVBORw0KGgo")) return "png";
  if (payload.startsWith("UklGR")) return "webp";
  if (payload.startsWith("R0lGOD")) return "gif";
  const normalized = String(preferred || "").toLowerCase().replace(/^\./, "");
  if (normalized === "jpg") return "jpeg";
  return ["png", "jpeg", "webp", "gif"].includes(normalized) ? normalized : "png";
}

function findBase64Payload(value, depth = 0) {
  if (depth > 6 || value == null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findBase64Payload(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && (key === "b64_json" || key === "base64")) return item;
    const hit = findBase64Payload(item, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function usableGeneratedImage(json) {
  const display = findImageRef(json);
  if (display && /^https?:\/\//.test(display)) return { usable: display, display };
  const payload = findBase64Payload(json);
  if (!payload) return display ? { usable: null, display } : null;
  const format = imageFormatFromBase64(payload, json.output_format);
  return {
    usable: `data:image/${format};base64,${payload}`,
    display: `base64(${payload.length} chars, image/${format})`,
  };
}

async function main() {
  if (!KEY) {
    const { res, json, ms } = await call("models-unauth", "/models");
    const code = json?.error?.code || "?";
    record(
      "reachability (no key)",
      res.status === 401 && code === "invalid_api_key",
      `HTTP ${res.status} code=${code} in ${ms}ms at ${BASE}`,
    );
    console.log("META_API_KEY not set — authenticated steps skipped. Add it to .env.local and re-run.");
    process.exit(2);
  }

  let imageUrl = argImage;
  let concept = "red stapler";

  try {
    const { res, json, ms } = await call("models", "/models");
    const ids = Array.isArray(json.data) ? json.data.map((m) => m.id) : [];
    record("GET /models", res.ok, `${ids.length} models in ${ms}ms; pinned present: spark=${ids.includes(SPARK)} sam=${ids.includes(SAM)} image=${ids.includes(IMAGE)}`);
    console.log("  model ids:", ids.join(", ") || "(none parsed)");
  } catch (e) {
    record("GET /models", false, String(e));
  }

  try {
    const { res, json, ms } = await call("persona", "/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: SPARK,
        messages: [
          { role: "system", content: "Return ONLY JSON {persona:{name,language,voiceRules,catchphrases,judgingStyle},challenge} for a photo game host. Roast photos, never people." },
          { role: "user", content: JSON.stringify({ brief: "a passive-aggressive IT helpdesk" }) },
        ],
      }),
    });
    const content = json?.choices?.[0]?.message?.content || "";
    record("Spark persona chat", res.ok && content.length > 0, `${ms}ms usage=${JSON.stringify(json.usage || {})} content[0:120]=${content.slice(0, 120)}`);
  } catch (e) {
    record("Spark persona chat", false, String(e));
  }

  try {
    const { res, json, ms, rawLen } = await call("image", "/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: IMAGE, prompt: "Photograph of a red stapler on a cluttered desk, daylight" }),
    });
    const generated = usableGeneratedImage(json);
    if (!imageUrl && generated?.usable) imageUrl = generated.usable;
    record("Muse Image generation", res.ok && !!generated?.usable, `${ms}ms ref=${generated?.display} output_format=${json.output_format || "?"} usage=${JSON.stringify(json.usage || {})} keys=${Object.keys(json).join(",")} bytes=${rawLen}`);
  } catch (e) {
    record("Muse Image generation", false, String(e));
  }

  if (!imageUrl) {
    record("Spark vision + SAM", false, "no image URL available (pass --image-url)");
  } else {
    try {
      const { res, json, ms } = await call("judge", "/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: SPARK,
          messages: [
            { role: "system", content: "Return ONLY JSON {objectLabel,scores:{fit,effort,chaos},teaser} for this photo vs the challenge. Scores must be integers from 0 to 5." },
            {
              role: "user",
              content: [
                { type: "text", text: JSON.stringify({ challenge: "Find the most suspicious object on your desk." }) },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
        }),
      });
      const content = json?.choices?.[0]?.message?.content || "";
      try {
        const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
        if (parsed.objectLabel) concept = parsed.objectLabel;
      } catch {
        /* keep default concept */
      }
      record("Spark vision judge", res.ok && content.length > 0, `${ms}ms usage=${JSON.stringify(json.usage || {})} concept=${concept} content[0:120]=${content.slice(0, 120)}`);
    } catch (e) {
      record("Spark vision judge", false, String(e));
    }

    try {
      const { res, json, ms, rawLen } = await call("sam", "/responses", {
        method: "POST",
        body: JSON.stringify({
          model: SAM,
          input: [
            {
              role: "user",
              content: [
                { type: "input_image", image_url: imageUrl },
                { type: "input_text", text: concept },
              ],
            },
          ],
        }),
      });
      const raw = JSON.stringify(json);
      const boxes = (raw.match(/<\|box;/g) || []).length;
      const masks = (raw.match(/<\|mask;/g) || []).length;
      record("SAM 3.1 /responses", res.ok && boxes > 0, `${ms}ms boxes=${boxes} masks=${masks} keys=${Object.keys(json).join(",")} bytes=${rawLen}`);
      if (!boxes) console.log("  SAM raw shape (first 800 chars):", raw.slice(0, 800));
    } catch (e) {
      record("SAM 3.1 /responses", false, String(e));
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nSmoke summary: ${results.length - failed}/${results.length} steps passed.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Smoke crashed:", e);
  process.exit(1);
});
