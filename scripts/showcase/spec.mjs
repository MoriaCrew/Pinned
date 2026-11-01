/**
 * Showcase set spec: validation, the element pick by pattern, and the
 * job budget (PIN-173). Pure: no I/O, so `spec.test.mjs` covers it
 * without a server. `docs/17-showcase-sets.md` is the contract.
 *
 * A set spec (one board) looks like this. Photo names are relative to
 * the photos folder, so a spec never holds a local path:
 *
 *   { "id": "cat", "title": "Showcase: cat (synthetic)", "themeId": "paper",
 *     "friends": [{ "name": "Aye", "photo": "cat/aye.webp" }, ...],
 *     "scenes": [{ "id": "c1-street", "prompt": "...",
 *                  "pick": [{ "friend": "Aye", "match": "cat|tabby" }, ...],
 *                  "names": ["cat", "beanie"] }] }
 *
 * A manifest file may hold several: `{ "sets": [ <set spec>, ... ] }`.
 */

// Mirrors the Policy defaults in src/policy/policy.ts (PIN-59): keep in sync.
export const SCENE_PROMPT_MAX = 500; // Policy.scenePromptMaxChars
export const PINS_PER_SCENE_MAX = 4; // Policy.pinsPerScene.max
export const BOARD_TITLE_MAX = 80; // Policy.boardTitleMaxChars

const MAX_FRIENDS = 6;
const MAX_SCENES = 3;
const MAX_PATTERN_CHARS = 120;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_RE = /^\p{Lu}[\p{L}'-]{0,23}$/u;
const PHOTO_RE = /\.(webp|jpe?g|png)$/i;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** A photo name must stay inside the photos folder: relative, no `..`, no drive letter. */
export function isRelativePhotoName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 120) return false;
  if (/[\\\0]/.test(name) || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..") && PHOTO_RE.test(name);
}

/** Compile a pick pattern: case-insensitive, no flags, bounded length. Throws on a bad pattern. */
export function compileMatch(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_PATTERN_CHARS) {
    throw new Error(`pattern must be 1 to ${MAX_PATTERN_CHARS} characters`);
  }
  return new RegExp(pattern, "i");
}

function validateScene(scene, at, friendNames, errors) {
  const err = (message) => errors.push(`${at}: ${message}`);
  if (!isObject(scene)) return err("must be an object");
  if (typeof scene.id !== "string" || !ID_RE.test(scene.id)) err("id must be lowercase letters, digits and dashes");
  const prompt = typeof scene.prompt === "string" ? scene.prompt.trim() : "";
  if (!prompt || [...prompt].length > SCENE_PROMPT_MAX) err(`prompt must be 1 to ${SCENE_PROMPT_MAX} characters`);
  if (!Array.isArray(scene.pick) || scene.pick.length < 1 || scene.pick.length > PINS_PER_SCENE_MAX) {
    return err(`pick must list 1 to ${PINS_PER_SCENE_MAX} things`);
  }
  const patterns = [];
  const pickedFriends = new Set();
  scene.pick.forEach((pick, i) => {
    const where = `${at}.pick[${i}]`;
    if (!isObject(pick) || !friendNames.has(pick.friend)) return errors.push(`${where}: friend must be one of the set's friends`);
    pickedFriends.add(pick.friend);
    let re;
    try {
      re = compileMatch(pick.match);
    } catch (e) {
      return errors.push(`${where}: match ${e.message}`);
    }
    patterns.push(re);
    // The prompt has to name each picked thing, or the pick has no effect on the scene.
    if (prompt && !re.test(prompt)) errors.push(`${where}: the prompt never names this thing (match /${pick.match}/)`);
  });
  if (pickedFriends.size < 2) err("pick must take things from at least 2 friends");
  if (scene.as !== undefined && !friendNames.has(scene.as)) err("as must be one of the set's friends");
  if (scene.names !== undefined) {
    if (!Array.isArray(scene.names) || scene.names.some((n) => typeof n !== "string" || !n.trim())) {
      return err("names must be a list of words");
    }
    // Every item the prompt names must be a picked pin: Muse Image draws an unpinned item
    // from the prompt text alone (PIN-171).
    for (const name of scene.names) {
      if (prompt && !prompt.toLowerCase().includes(name.toLowerCase())) err(`names: "${name}" is not in the prompt`);
      if (!patterns.some((re) => re.test(name))) err(`names: "${name}" has no pick that matches it`);
    }
  }
}

/** Every problem with a set spec, as plain sentences. An empty list means the spec is fine. */
export function validateSpec(spec) {
  const errors = [];
  const err = (message) => errors.push(message);
  if (!isObject(spec)) return ["a set spec must be a JSON object"];
  if (typeof spec.id !== "string" || !ID_RE.test(spec.id)) err("id must be lowercase letters, digits and dashes");
  if (typeof spec.title !== "string" || !spec.title.trim() || [...spec.title].length > BOARD_TITLE_MAX) {
    err(`title must be 1 to ${BOARD_TITLE_MAX} characters`);
  }
  if (spec.themeId !== undefined && typeof spec.themeId !== "string") err("themeId must be a string");
  const friendNames = new Set();
  if (!Array.isArray(spec.friends) || spec.friends.length < 2 || spec.friends.length > MAX_FRIENDS) {
    err(`friends must list 2 to ${MAX_FRIENDS} people`);
  } else {
    spec.friends.forEach((friend, i) => {
      const at = `friends[${i}]`;
      if (!isObject(friend) || typeof friend.name !== "string" || !NAME_RE.test(friend.name)) {
        return err(`${at}: name must be a made-up first name`);
      }
      if ([...friendNames].some((n) => n.toLowerCase() === friend.name.toLowerCase())) err(`${at}: duplicate name`);
      friendNames.add(friend.name);
      if (!isRelativePhotoName(friend.photo)) err(`${at}: photo must be a relative .webp, .jpg or .png name (no local paths)`);
    });
  }
  if (!Array.isArray(spec.scenes) || spec.scenes.length > MAX_SCENES) {
    err(`scenes must be a list of at most ${MAX_SCENES}`);
  } else {
    const ids = new Set();
    spec.scenes.forEach((scene, i) => {
      if (isObject(scene) && ids.has(scene.id)) err(`scenes[${i}]: duplicate id`);
      if (isObject(scene)) ids.add(scene.id);
      validateScene(scene, `scenes[${i}]`, friendNames, errors);
    });
  }
  return errors;
}

/**
 * The spec for one set from a file's text: a single spec, or a manifest with `sets`
 * (then `setId` is required). Throws with every problem listed.
 */
export function parseSpec(text, setId) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("spec is not valid JSON");
  }
  let spec = json;
  if (isObject(json) && Array.isArray(json.sets)) {
    spec = json.sets.find((s) => isObject(s) && s.id === setId);
    if (!spec) throw new Error(`no set "${setId ?? ""}" in the manifest (have: ${json.sets.map((s) => s?.id).join(", ")})`);
  } else if (setId !== undefined && isObject(json) && json.id !== setId) {
    throw new Error(`spec is for set "${json.id}", not "${setId}"`);
  }
  const errors = validateSpec(spec);
  if (errors.length) throw new Error(`invalid spec:\n- ${errors.join("\n- ")}`);
  return spec;
}

/** The ids of every set in a spec file's text (one, or the manifest's). */
export function listSetIds(text) {
  const json = JSON.parse(text);
  return Array.isArray(json?.sets) ? json.sets.map((s) => s?.id) : [json?.id];
}

/**
 * Pick a friend's element by pattern. A label match beats a description match
 * (Spark words the same thing differently from run to run), and an element
 * already used by another pick is skipped.
 */
export function pickElement(elements, friend, pattern, used = new Set()) {
  return findByPattern(elements.filter((e) => e.friend === friend && !used.has(e.id)), pattern);
}

/** The first of `candidates` whose label matches, else the first whose description does. `run` and `web` both pick this way. */
export function findByPattern(candidates, pattern) {
  const re = compileMatch(pattern);
  return candidates.find((e) => re.test(e.label ?? "")) ?? candidates.find((e) => re.test(e.description ?? "")) ?? null;
}

/**
 * Resolve a scene's picks against the elements the photos produced.
 * `missing` lists picks with no element: the scene must not run then,
 * or Muse Image would draw the missing thing from the prompt alone.
 */
export function resolveScenePicks(scene, elements) {
  const used = new Set();
  const ids = [];
  const picked = [];
  const missing = [];
  for (const pick of scene.pick) {
    const element = pickElement(elements, pick.friend, pick.match, used);
    if (!element) {
      missing.push({ friend: pick.friend, match: pick.match });
      continue;
    }
    used.add(element.id);
    ids.push(element.id);
    picked.push({ friend: element.friend, label: element.label });
  }
  return { ids, picked, missing };
}

/** Jobs a run starts: one decompose per photo (a retry is another) and one per scene attempt. */
export function planJobs(specs, { sceneTries = 3 } = {}) {
  let min = 0;
  let max = 0;
  for (const spec of specs) {
    min += spec.friends.length + spec.scenes.length;
    max += spec.friends.length * 2 + spec.scenes.length * sceneTries;
  }
  return { min, max };
}

export class BudgetError extends Error {}

/** A hard cap on the model jobs one run may start; `spend` throws before the job over the cap. */
export class JobBudget {
  constructor(max) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError("the job cap must be a positive whole number");
    this.max = max;
    this.used = 0;
  }
  spend(what) {
    if (this.used >= this.max) throw new BudgetError(`job cap of ${this.max} reached before ${what}; raise --max-jobs only on purpose`);
    this.used += 1;
  }
}
