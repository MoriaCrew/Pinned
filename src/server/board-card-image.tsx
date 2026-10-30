import "server-only";
/**
 * Board link card renderer (PIN-102). next/og draws the copy (the
 * wordmark, invite line, title in the skin's display face, counts)
 * over an SVG ground; sharp then lays the baked sticker pile on top
 * and re-encodes the PNG. Every failure degrades instead of 500ing:
 * board card -> generic Pinneds card -> the static og-card.png.
 */
import { ImageResponse } from "next/og";
import sharp from "sharp";
import {
  CARD_SIZE,
  CARD_SKIN_STYLES,
  cardInviteLine,
  cardMetaLine,
  cardText,
  cardTitleSize,
  cardTitleText,
} from "../domain/board-card";
import type { BoardRepository } from "../domain/board-repository";
import { DEFAULT_SKIN, type SkinId } from "../domain/skins";
import { t } from "../i18n";
import type { Policy } from "../policy/policy";
import {
  CARD_FONTS,
  cardBackgroundSvg,
  cardColors,
  composePile,
  loadBoardCard,
  loadCardFonts,
  parseColor,
  staticFallbackCard,
  type BoardCardData,
} from "./board-card";
import type { DerivativeStore } from "./derivative-store";
import { logServerError } from "./safe-log";

/** What one card draws, resolved from a board or the generic card. */
export interface CardView {
  skin: SkinId;
  invite: string;
  title: string;
  meta: string;
  /** Cut-outs for the pile; none draws dashed ghost outlines instead. */
  stickers: Array<{ id: string; bytes: Buffer }>;
}

export function boardCardView(data: BoardCardData): CardView {
  const { model } = data;
  return {
    skin: model.skin,
    invite: cardInviteLine(model.inviter),
    title: cardTitleText(model.title, model.skin),
    meta: cardMetaLine(model.counts),
    stickers: data.stickers,
  };
}

/** Bad slug, missing board or a failed board card: the brand on Paper. */
export function genericCardView(): CardView {
  return {
    skin: DEFAULT_SKIN,
    invite: t("en", "card.fallbackInvite"),
    title: t("en", "card.fallbackTitle"),
    meta: "",
    stickers: [],
  };
}

/* The design's copy column, in cqw of the 1200px card (LinkPreview). */
const CQW = CARD_SIZE.width / 100;
const COPY = { left: 5 * CQW, top: 5 * CQW, width: 50 * CQW, gap: 1.2 * CQW };
const WORDMARK_SIZE = 3.6 * CQW;
const INVITE_SIZE = 2.3 * CQW;
const META_SIZE = 1.9 * CQW;

/**
 * The wordmark as the UI kit draws it (.pn-wordmark): lowercase
 * "pinneds" in Bricolage Grotesque, the dotless i topped with a dot
 * in the skin's accent. Offsets are tuned for the renderer, which
 * places the glyph box a little lower than a browser does.
 */
function Wordmark({ ink, accent }: { ink: string; accent: string }) {
  const size = WORDMARK_SIZE;
  const dot = 0.3 * size;
  const shade = parseColor(ink);
  return (
    <div
      style={{
        display: "flex",
        fontFamily: CARD_FONTS.wordmark.name,
        fontWeight: CARD_FONTS.wordmark.weight,
        fontSize: size,
        lineHeight: 1,
        letterSpacing: -0.035 * size,
        color: ink,
      }}
    >
      <span>p</span>
      <span style={{ display: "flex", position: "relative" }}>
        {"ı"}
        <span
          style={{
            position: "absolute",
            left: "50%",
            top: -0.01 * size,
            width: dot,
            height: dot,
            marginLeft: -dot / 2 - 0.0175 * size,
            borderRadius: dot,
            backgroundColor: accent,
            boxShadow: `inset ${-0.04 * size}px ${-0.05 * size}px 0 rgba(${shade.r}, ${shade.g}, ${shade.b}, 0.22)`,
          }}
        />
      </span>
      <span>nneds</span>
    </div>
  );
}

function CardMarkup({ view, background }: { view: CardView; background: string }) {
  const c = cardColors(view.skin);
  const display = CARD_SKIN_STYLES[view.skin].display;
  const titleSize = cardTitleSize(view.title, view.skin);
  const { width: W, height: H } = CARD_SIZE;
  return (
    <div style={{ width: W, height: H, display: "flex", position: "relative", backgroundColor: c.surface }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- rendered by next/og, not the browser */}
      <img src={background} width={W} height={H} alt="" style={{ position: "absolute", left: 0, top: 0 }} />
      <div
        style={{
          position: "absolute",
          left: COPY.left,
          top: COPY.top,
          bottom: COPY.top,
          width: COPY.width,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
        }}
      >
        <Wordmark ink={c.ink} accent={c.accent} />
        <div
          style={{
            display: "flex",
            marginTop: "auto",
            maxWidth: COPY.width,
            fontFamily: CARD_FONTS.ui.name,
            fontWeight: CARD_FONTS.ui.weight,
            fontSize: INVITE_SIZE,
            lineHeight: 1.3,
            color: c.inkMuted,
          }}
        >
          {view.invite}
        </div>
        <div
          style={{
            display: "flex",
            marginTop: COPY.gap,
            maxWidth: COPY.width,
            fontFamily: display.family,
            fontWeight: display.weight,
            fontStyle: display.style,
            fontSize: titleSize,
            lineHeight: 1.02,
            letterSpacing: display.trackingEm * titleSize,
            wordBreak: "break-word",
            color: c.ink,
          }}
        >
          {view.title}
        </div>
        {view.meta ? (
          <div
            style={{
              display: "flex",
              marginTop: COPY.gap + 0.6 * CQW,
              fontFamily: CARD_FONTS.mono.name,
              fontWeight: CARD_FONTS.mono.weight,
              fontSize: META_SIZE,
              lineHeight: 1.3,
              color: c.inkMuted,
            }}
          >
            {view.meta}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Draw one card to PNG bytes (throws on any render failure). */
export async function renderCardPng(input: CardView): Promise<Buffer> {
  // Only glyphs the bundled fonts carry: anything else would make the
  // renderer fetch fonts/emoji from a CDN (and an emoji fetch throws).
  const view = { ...input, invite: cardText(input.invite), title: cardText(input.title), meta: cardText(input.meta) };
  const [fonts, pile] = await Promise.all([
    loadCardFonts(view.skin),
    view.stickers.length > 0 ? composePile(view.stickers, view.skin) : Promise.resolve(null),
  ]);
  // Nothing pinned yet (or no cut-out could be drawn): dashed ghosts.
  const background = `data:image/svg+xml;base64,${Buffer.from(
    cardBackgroundSvg(view.skin, { ghosts: !pile }),
  ).toString("base64")}`;
  // ImageResponse renders lazily into its body stream: read it here
  // so a font or layout failure throws inside our try, not mid-response.
  const response = new ImageResponse(<CardMarkup view={view} background={background} />, {
    ...CARD_SIZE,
    fonts,
  });
  if (!response.ok) throw new Error(`Card render failed (${response.status}).`);
  const base = Buffer.from(await response.arrayBuffer());
  const card = sharp(base);
  if (pile) card.composite([{ input: pile }]);
  return card.png({ compressionLevel: 9, palette: true, quality: 92, effort: 8, dither: 0.6 }).toBuffer();
}

export interface BoardCardImageDeps {
  boards: BoardRepository;
  store: DerivativeStore;
  /** Policy for a board (its stored overrides, or none). */
  policyFor: (overrides: BoardCardData["policyOverrides"] | null) => Policy;
}

function pngResponse(bytes: Buffer, policy: Policy): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.length),
      // Same rule as the scene image chat crawlers fetch (PIN-72):
      // a short private cache, never a shared one.
      "Cache-Control": `private, max-age=${policy.sceneImageCacheMaxAgeSeconds}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * The link card for /g/{slug}. A malformed slug or a missing board
 * gets the generic card (same bytes either way: no existence leak);
 * any failure falls back to the generic card, then to the static
 * static og-card.png. Always 200 with a PNG.
 */
export async function boardCardImage(slug: string, deps: BoardCardImageDeps): Promise<Response> {
  let policy = deps.policyFor(null);
  try {
    const data = await loadBoardCard(slug, deps);
    if (data?.policyOverrides) policy = deps.policyFor(data.policyOverrides);
    return pngResponse(await renderCardPng(data ? boardCardView(data) : genericCardView()), policy);
  } catch (error) {
    logServerError("board card render failed", error);
  }
  try {
    return pngResponse(await renderCardPng(genericCardView()), policy);
  } catch (error) {
    logServerError("generic card render failed", error);
  }
  return pngResponse(await staticFallbackCard(), policy);
}
