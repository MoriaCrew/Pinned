import "server-only";
/**
 * Board link card data + sticker baking (PIN-102). Loads what the
 * card shows for a board (src/domain/board-card.ts decides what),
 * reads each sticker's stored cut-out exactly like the element image
 * route (board-checked, elements/ refs only, never tmp/), and bakes
 * the die-cut look with sharp: next/og has no CSS filters, so the
 * white keyline (alpha dilation) and the soft or hard shadow are
 * drawn into one transparent 1200 x 630 pile layer here.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import {
  CARD_SIZE,
  CARD_SKIN_STYLES,
  CARD_UI_SCALE,
  GHOST_SLOTS,
  cardModel,
  cardStickerTilt,
  pileSlots,
  type CardModel,
  type CardSlot,
} from "../domain/board-card";
import type { BoardRepository } from "../domain/board-repository";
import type { PolicyOverrides } from "../policy/policy";
import type { SkinId } from "../domain/skins";
import { isValidSlug } from "../domain/tokens";
import tokens from "../ui/tokens.json";
import type { DerivativeStore } from "./derivative-store";

export interface BoardCardDeps {
  boards: BoardRepository;
  store: DerivativeStore;
}

export interface BoardCardData {
  model: CardModel;
  /** Cut-out PNG bytes in pile order (newest pin first). */
  stickers: Array<{ id: string; bytes: Buffer }>;
  /** The board's Policy layer (cache header), when it has one. */
  policyOverrides?: PolicyOverrides;
}

/**
 * Card data for a board link, or null for a malformed slug or a
 * missing board (the caller draws the generic card for both, so
 * the image never reveals whether a board exists). A cut-out that
 * cannot be read is left out of the pile instead of failing.
 */
export async function loadBoardCard(slug: string, deps: BoardCardDeps): Promise<BoardCardData | null> {
  if (!isValidSlug(slug)) return null;
  const board = await deps.boards.getBoard(slug);
  if (!board) return null;
  const [participants, pins, elements, scenes] = await Promise.all([
    deps.boards.listParticipants(slug),
    deps.boards.listPins(slug, "pinned"),
    deps.boards.listElements(slug),
    deps.boards.listScenes(slug),
  ]);
  const model = cardModel({ board, participants, pins, elements, scenes });
  const byId = new Map(elements.map((element) => [element.id, element]));
  const stickers = await Promise.all(
    model.stickerIds.map(async (id) => {
      const ref = byId.get(id)?.cutoutRef;
      if (!ref || !ref.startsWith("elements/")) return null;
      const bytes = await deps.store.get(ref).catch(() => null);
      return bytes ? { id, bytes } : null;
    }),
  );
  return {
    model,
    stickers: stickers.filter((s): s is { id: string; bytes: Buffer } => s !== null),
    ...(board.policyOverrides ? { policyOverrides: board.policyOverrides } : {}),
  };
}

/* ---------- Colours (src/ui/tokens.json) ---------- */

export interface CardColors {
  surface: string;
  surfaceRaised: string;
  surfaceSunk: string;
  ink: string;
  inkMuted: string;
  line: string;
  lineStrong: string;
  accent: string;
  mark: string;
  keyline: string;
  shade: string;
  person2: string;
}

type ColorToken = { name: string; value: string | Record<string, string> };

function token(name: string, skin: SkinId): string {
  const found = (tokens.color.tokens as ColorToken[]).find((t) => t.name === name);
  if (!found) throw new Error(`Missing colour token ${name}.`);
  return typeof found.value === "string" ? found.value : found.value[skin] ?? found.value.paper;
}

export function cardColors(skin: SkinId): CardColors {
  return {
    surface: token("surface", skin),
    surfaceRaised: token("surface-raised", skin),
    surfaceSunk: token("surface-sunk", skin),
    ink: token("ink", skin),
    inkMuted: token("ink-muted", skin),
    line: token("line", skin),
    lineStrong: token("line-strong", skin),
    accent: token("accent", skin),
    mark: token("mark", skin),
    keyline: token("keyline", skin),
    shade: token("shade", skin),
    person2: token("person-2", skin),
  };
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  alpha: number;
}

/** "#rrggbb" or "rgba(r, g, b, a)" -> channels. */
export function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
  if (hex) {
    return { r: parseInt(hex[1], 16), g: parseInt(hex[2], 16), b: parseInt(hex[3], 16), alpha: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value.trim());
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      alpha: rgba[4] === undefined ? 1 : Math.min(1, Math.max(0, Number(rgba[4]))),
    };
  }
  throw new Error(`Unsupported colour ${value}.`);
}

/* ---------- Ground, band and ghosts (one SVG layer) ---------- */

const S = CARD_UI_SCALE;
/** Band height: 1.4cqw of the design. */
const BAND_HEIGHT = 0.014 * CARD_SIZE.width;

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function groundPattern(skin: SkinId, c: CardColors): string {
  const ground = CARD_SKIN_STYLES[skin].ground;
  const { width: W, height: H } = CARD_SIZE;
  // Patterns are drawn finer than the full card scale so they read as
  // a texture behind the stickers, not as polka dots.
  const k = S * 0.6;
  const dots = (id: string, w: number, h: number, r: number, fill: string, opacity = 1, at = [0.5, 0.5], turn = 0) =>
    `<pattern id="${id}" width="${fmt(w)}" height="${fmt(h)}" patternUnits="userSpaceOnUse"` +
    (turn ? ` patternTransform="rotate(${turn})"` : "") +
    `><circle cx="${fmt(w * at[0])}" cy="${fmt(h * at[1])}" r="${fmt(r)}" fill="${fill}" fill-opacity="${opacity}"/></pattern>`;
  const fill = (id: string) => `<rect width="${W}" height="${H}" fill="url(#${id})"/>`;
  switch (ground) {
    case "dots":
      return `<defs>${dots("g1", 6 * S, 6 * S, 1.0 * S, c.line)}</defs>${fill("g1")}`;
    case "speckle":
      return (
        `<defs>${dots("g1", 9 * k, 9 * k, 1.4 * k, c.surfaceSunk, 1, [0.3, 0.6], 17)}` +
        `${dots("g2", 13 * k, 13 * k, 0.9 * k, c.line, 0.8, [0.7, 0.2], -23)}` +
        `${dots("g3", 7 * k, 11 * k, 1.0 * k, c.surfaceSunk, 1, [0.5, 0.5], 41)}</defs>` +
        fill("g1") + fill("g2") + fill("g3")
      );
    case "confetti":
      return `<defs>${dots("g1", 22 * S, 22 * S, 1.6 * S * 0.8, c.mark, 0.3)}</defs>${fill("g1")}`;
    case "sheen":
      return (
        `<defs><linearGradient id="g1" x1="0" y1="0.4" x2="1" y2="0.6">` +
        `<stop offset="0.35" stop-color="${c.surfaceRaised}" stop-opacity="0"/>` +
        `<stop offset="0.5" stop-color="${c.surfaceRaised}" stop-opacity="0.55"/>` +
        `<stop offset="0.65" stop-color="${c.surfaceRaised}" stop-opacity="0"/></linearGradient></defs>` +
        fill("g1")
      );
    default:
      return "";
  }
}

function band(skin: SkinId, c: CardColors): string {
  const kind = CARD_SKIN_STYLES[skin].band;
  const W = CARD_SIZE.width;
  if (kind === "airmail") {
    // repeating-linear-gradient(-45deg, accent 0 9px, raised 9px 15px, person-2 15px 24px, raised 24px 30px)
    const p = 30 * S;
    return (
      `<defs><pattern id="b1" width="${fmt(p)}" height="${fmt(p)}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<rect width="${fmt(p)}" height="${fmt(p)}" fill="${c.surfaceRaised}"/>` +
      `<rect width="${fmt(9 * S)}" height="${fmt(p)}" fill="${c.accent}"/>` +
      `<rect x="${fmt(15 * S)}" width="${fmt(9 * S)}" height="${fmt(p)}" fill="${c.person2}"/></pattern></defs>` +
      `<rect width="${W}" height="${fmt(BAND_HEIGHT)}" fill="url(#b1)"/>`
    );
  }
  if (kind === "picado") {
    // conic-gradient(from 135deg at 50% 0, accent 90deg, transparent 0) 16px tiles + a 2px mark line on top.
    const tile = 16 * S;
    const h = BAND_HEIGHT;
    const reach = Math.min(h, tile / 2);
    return (
      `<defs><pattern id="b1" width="${fmt(tile)}" height="${fmt(h)}" patternUnits="userSpaceOnUse">` +
      `<polygon points="${fmt(tile / 2)},0 ${fmt(tile / 2 + reach)},${fmt(reach)} ${fmt(tile / 2 + reach)},${fmt(h)} ` +
      `${fmt(tile / 2 - reach)},${fmt(h)} ${fmt(tile / 2 - reach)},${fmt(reach)}" fill="${c.accent}"/></pattern></defs>` +
      `<rect width="${W}" height="${fmt(h)}" fill="url(#b1)"/>` +
      `<rect width="${W}" height="${fmt(2 * S)}" fill="${c.mark}"/>`
    );
  }
  return "";
}

/** CSS border-radius 40% 46% 38% 50% as a path in a size x size box. */
function blobPath(size: number): string {
  const [tl, tr, br, bl] = [0.4, 0.46, 0.38, 0.5].map((f) => f * size);
  return (
    `M${fmt(tl)},0 H${fmt(size - tr)} A${fmt(tr)},${fmt(tr)} 0 0 1 ${fmt(size)},${fmt(tr)} ` +
    `V${fmt(size - br)} A${fmt(br)},${fmt(br)} 0 0 1 ${fmt(size - br)},${fmt(size)} ` +
    `H${fmt(bl)} A${fmt(bl)},${fmt(bl)} 0 0 1 0,${fmt(size - bl)} ` +
    `V${fmt(tl)} A${fmt(tl)},${fmt(tl)} 0 0 1 ${fmt(tl)},0 Z`
  );
}

function ghosts(skin: SkinId, c: CardColors): string {
  // .pn-ghost: a 2px dashed line-strong edge on a 72px blob, scaled to the card.
  const stroke = 2 * S * 0.7;
  return GHOST_SLOTS.map((slot, i) => {
    // .pn-ghost leans twice the skin tilt so the outlines read as loose.
    const angle = cardStickerTilt(`ghost-${i + 1}`, skin) * 2;
    return (
      `<g transform="translate(${fmt(slot.x)} ${fmt(slot.y)}) rotate(${fmt(angle)} ${fmt(slot.size / 2)} ${fmt(slot.size / 2)})">` +
      `<path d="${blobPath(slot.size)}" fill="none" stroke="${c.lineStrong}" stroke-width="${fmt(stroke)}" ` +
      `stroke-dasharray="${fmt(stroke * 3)} ${fmt(stroke * 2)}" stroke-linecap="round"/></g>`
    );
  }).join("");
}

/**
 * Background layer: ground pattern, top band and, for a board with
 * nothing pinned yet, the dashed ghost outlines. Plain SVG so the
 * renderer draws it without CSS gradient support.
 */
export function cardBackgroundSvg(skin: SkinId, options: { ghosts: boolean }): string {
  const c = cardColors(skin);
  const { width: W, height: H } = CARD_SIZE;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${c.surface}"/>` +
    groundPattern(skin, c) +
    (options.ghosts ? ghosts(skin, c) : "") +
    band(skin, c) +
    `</svg>`
  );
}

/* ---------- Stickers ---------- */

/** .pn-sticker img is inset 5px inside its box. */
const STICKER_INSET = 5 * S;
/** Alpha level that counts as part of the thing when trimming. */
const ALPHA_EDGE = 16;
/** Keyline edge softness, card px (antialiasing ramp). */
const KEYLINE_RAMP_PX = 1.2;

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

async function blur1(mask: Uint8Array, size: number, sigma: number): Promise<Uint8Array> {
  if (sigma < 0.3) return mask;
  const out = await sharp(Buffer.from(mask), { raw: { width: size, height: size, channels: 1 } })
    .blur(sigma)
    .extractChannel(0)
    .raw()
    .toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Grow an alpha mask by `radius` px with a soft edge: Gaussian blur,
 * then a steep ramp around the level a straight edge reaches at that
 * distance (sigma = radius / 1.2 puts it at the 11.5% tail).
 */
async function dilate(mask: Uint8Array, size: number, radius: number): Promise<Uint8Array> {
  if (radius <= 0) return mask;
  const sigma = radius / 1.2;
  const blurred = await blur1(mask, size, sigma);
  const level = 255 * 0.1151;
  const slope = (255 * 0.1942) / sigma; // value change per px at that distance
  const gain = 255 / (KEYLINE_RAMP_PX * slope);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    out[i] = Math.max(mask[i], clampByte(Math.round(gain * (blurred[i] - level) + 128)));
  }
  return out;
}

interface Layer {
  rgb: Rgba;
  alpha: Uint8Array;
}

/** Straight-alpha "over": paint a flat-colour layer onto dst (RGBA). */
function paint(dst: Uint8Array, layer: Layer): void {
  const { r, g, b, alpha: k } = layer.rgb;
  for (let i = 0, p = 0; i < layer.alpha.length; i++, p += 4) {
    const as = (layer.alpha[i] / 255) * k;
    if (as <= 0) continue;
    const ab = dst[p + 3] / 255;
    const a = as + ab * (1 - as);
    dst[p] = Math.round((r * as + dst[p] * ab * (1 - as)) / a);
    dst[p + 1] = Math.round((g * as + dst[p + 1] * ab * (1 - as)) / a);
    dst[p + 2] = Math.round((b * as + dst[p + 2] * ab * (1 - as)) / a);
    dst[p + 3] = Math.round(a * 255);
  }
}

/** Straight-alpha "over" of an RGBA image of the same size. */
function paintImage(dst: Uint8Array, src: Uint8Array): void {
  for (let p = 0; p < src.length; p += 4) {
    const as = src[p + 3] / 255;
    if (as <= 0) continue;
    const ab = dst[p + 3] / 255;
    const a = as + ab * (1 - as);
    for (let ch = 0; ch < 3; ch++) {
      dst[p + ch] = Math.round((src[p + ch] * as + dst[p + ch] * ab * (1 - as)) / a);
    }
    dst[p + 3] = Math.round(a * 255);
  }
}

function shift(mask: Uint8Array, size: number, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  const ox = Math.round(dx);
  const oy = Math.round(dy);
  for (let y = 0; y < size; y++) {
    const sy = y - oy;
    if (sy < 0 || sy >= size) continue;
    for (let x = 0; x < size; x++) {
      const sx = x - ox;
      if (sx < 0 || sx >= size) continue;
      out[y * size + x] = mask[sy * size + sx];
    }
  }
  return out;
}

export interface BakedSticker {
  /** Transparent PNG, already rotated; centre it on the slot centre. */
  png: Buffer;
  width: number;
  height: number;
}

/**
 * One die-cut sticker: the cut-out trimmed to its visible pixels,
 * fitted inside the slot box, a keyline in the skin's keyline colour
 * around its silhouette, the skin's lift shadow under that, a
 * pushpin for Cork, then the thing's stable tilt. Null when the
 * cut-out has no visible pixels.
 */
export async function bakeSticker(
  bytes: Buffer,
  opts: { skin: SkinId; size: number; seed: string },
): Promise<BakedSticker | null> {
  const style = CARD_SKIN_STYLES[opts.skin];
  const colors = cardColors(opts.skin);
  const src = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: sw, height: sh, channels } = src.info;
  let x1 = sw;
  let y1 = sh;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (src.data[(y * sw + x) * channels + 3] > ALPHA_EDGE) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < x1 || y2 < y1) return null;

  const inner = Math.max(1, Math.round(opts.size - 2 * STICKER_INSET));
  const fitted = await sharp(src.data, { raw: { width: sw, height: sh, channels } })
    .extract({ left: x1, top: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 })
    .resize({ width: inner, height: inner, fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const fw = fitted.info.width;
  const fh = fitted.info.height;

  const keyline = style.keylinePx * S;
  const lift = { x: style.lift.x * S, y: style.lift.y * S, sigma: (style.lift.blur * S) / 2 };
  const pad = Math.ceil(keyline + Math.abs(lift.x) + Math.abs(lift.y) + 3 * lift.sigma + 4);
  const size = Math.round(opts.size) + 2 * pad;
  const ox = Math.round((size - fw) / 2);
  const oy = Math.round((size - fh) / 2);

  const thing = new Uint8Array(size * size * 4);
  const alpha = new Uint8Array(size * size);
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const s = (y * fw + x) * 4;
      const d = (y + oy) * size + (x + ox);
      thing.set(fitted.data.subarray(s, s + 4), d * 4);
      alpha[d] = fitted.data[s + 3];
    }
  }

  const outline = await dilate(alpha, size, keyline);
  const shadowMask = shift(await blur1(outline, size, lift.sigma), size, lift.x, lift.y);
  const out = new Uint8Array(size * size * 4);
  paint(out, { rgb: parseColor(colors.shade), alpha: shadowMask });
  if (keyline > 0) paint(out, { rgb: parseColor(colors.keyline), alpha: outline });
  paintImage(out, thing);

  let image = sharp(Buffer.from(out.buffer, out.byteOffset, out.byteLength), {
    raw: { width: size, height: size, channels: 4 },
  });
  if (style.pushpin) {
    // .pn-sticker::before: a 15px pin-head in the accent colour, pushed in at the top of the thing.
    const r = (15 / 2) * S * 0.8;
    const pin =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<defs><radialGradient id="p" cx="0.34" cy="0.32" r="0.7">` +
      `<stop offset="0.2" stop-color="${colors.surfaceRaised}" stop-opacity="0.65"/>` +
      `<stop offset="0.45" stop-color="${colors.accent}"/></radialGradient>` +
      `<filter id="s" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${fmt(1 * S)}" dy="${fmt(4 * S * 0.8)}" ` +
      `stdDeviation="${fmt(1.5 * S)}" flood-color="#000" flood-opacity="${fmt(parseColor(colors.shade).alpha)}"/></filter></defs>` +
      `<circle cx="${fmt(size / 2)}" cy="${fmt(oy + r * 0.9)}" r="${fmt(r)}" fill="url(#p)" filter="url(#s)"/></svg>`;
    const flat = await image.composite([{ input: Buffer.from(pin) }]).raw().toBuffer();
    image = sharp(flat, { raw: { width: size, height: size, channels: 4 } });
  }
  const angle = cardStickerTilt(opts.seed, opts.skin);
  if (Math.abs(angle) >= 0.05) {
    image = image.rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }
  const { data, info } = await image.png().toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height };
}

/**
 * The sticker pile as one transparent card-sized PNG, stickers drawn
 * in slot order (later ones on top). Stickers that fail to decode
 * are skipped; returns null when none could be drawn.
 */
export async function composePile(
  stickers: ReadonlyArray<{ id: string; bytes: Buffer }>,
  skin: SkinId,
): Promise<Buffer | null> {
  const slots: CardSlot[] = pileSlots(stickers.length);
  const baked = await Promise.all(
    stickers.slice(0, slots.length).map((sticker, i) =>
      bakeSticker(sticker.bytes, { skin, size: slots[i].size, seed: sticker.id }).catch(() => null),
    ),
  );
  const { width: W, height: H } = CARD_SIZE;
  const margin = Math.ceil(Math.max(0, ...baked.map((b) => (b ? Math.max(b.width, b.height) : 0))) / 2) + 1;
  const layers: OverlayOptions[] = [];
  baked.forEach((b, i) => {
    if (!b) return;
    const slot = slots[i];
    const cx = slot.x + slot.size / 2;
    const cy = slot.y + slot.size / 2;
    layers.push({ input: b.png, left: Math.round(margin + cx - b.width / 2), top: Math.round(margin + cy - b.height / 2) });
  });
  if (layers.length === 0) return null;
  const canvas = await sharp({
    create: { width: W + 2 * margin, height: H + 2 * margin, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(layers)
    .raw()
    .toBuffer();
  return sharp(canvas, { raw: { width: W + 2 * margin, height: H + 2 * margin, channels: 4 } })
    .extract({ left: margin, top: margin, width: W, height: H })
    .png()
    .toBuffer();
}

/* ---------- Fonts ---------- */

/**
 * TTF faces for the renderer (src/server/og-fonts, OFL; next.config
 * traces the folder into the server bundle). Read once per process.
 */
const FONT_DIR = path.join(process.cwd(), "src", "server", "og-fonts");

export const CARD_FONTS = {
  ui: { name: "Atkinson Hyperlegible Next", file: "AtkinsonHyperlegibleNext-600.ttf", weight: 600, style: "normal" },
  mono: { name: "Atkinson Hyperlegible Mono", file: "AtkinsonHyperlegibleMono-500.ttf", weight: 500, style: "normal" },
  wordmark: { name: "Bricolage Grotesque", file: "BricolageGrotesque-800.ttf", weight: 800, style: "normal" },
} as const;

const DISPLAY_FILES: Readonly<Record<SkinId, string>> = {
  paper: "BricolageGrotesque-800.ttf",
  cork: "Fraunces-600.ttf",
  fridge: "Fredoka-600.ttf",
  zine: "Anton-400.ttf",
  darkroom: "InstrumentSerif-400-italic.ttf",
  postcard: "YoungSerif-400.ttf",
  marigold: "AbrilFatface-400.ttf",
};

export interface CardFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 500 | 600 | 700 | 800;
  style: "normal" | "italic";
}

const fontCache = new Map<string, Promise<ArrayBuffer>>();

function fontData(file: string): Promise<ArrayBuffer> {
  let hit = fontCache.get(file);
  if (!hit) {
    hit = readFile(path.join(FONT_DIR, file)).then((buf) =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    // A failed read is retried on the next card instead of being cached.
    hit.catch(() => fontCache.delete(file));
    fontCache.set(file, hit);
  }
  return hit;
}

/** The reading face, the mono face, the wordmark and the skin's display face. */
export async function loadCardFonts(skin: SkinId): Promise<CardFont[]> {
  const display = CARD_SKIN_STYLES[skin].display;
  const specs: Array<{ name: string; file: string; weight: number; style: "normal" | "italic" }> = [
    CARD_FONTS.ui,
    CARD_FONTS.mono,
    CARD_FONTS.wordmark,
  ];
  if (DISPLAY_FILES[skin] !== CARD_FONTS.wordmark.file) {
    specs.push({ name: display.family, file: DISPLAY_FILES[skin], weight: display.weight, style: display.style });
  }
  return Promise.all(
    specs.map(async (spec) => ({
      name: spec.name,
      data: await fontData(spec.file),
      weight: spec.weight as CardFont["weight"],
      style: spec.style,
    })),
  );
}

/**
 * Branded card (PIN-72): the last-resort image. A server-side copy
 * lives in src/server/og-assets/ and is traced into the bundle
 * (next.config.ts); public/og-card.png stays the public URL. Never
 * trace from public/: see the note in next.config.ts (PIN-116).
 */
export async function staticFallbackCard(): Promise<Buffer> {
  try {
    return await readFile(path.join(process.cwd(), "src", "server", "og-assets", "og-card.png"));
  } catch {
    const c = parseColor(cardColors("paper").surface);
    return sharp({
      create: { ...CARD_SIZE, channels: 4, background: { r: c.r, g: c.g, b: c.b, alpha: 1 } },
    })
      .png()
      .toBuffer();
  }
}
