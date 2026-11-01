import { CARD_SIZE } from "../../../domain/board-card";
import { t } from "../../../i18n";
import { getPolicy } from "../../../policy/server";
import { boardCardImage } from "../../../server/board-card-image";
import { getBoardRepository } from "../../../server/board-repository";
import { getDerivativeStore } from "../../../server/derivative-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const alt = t("en", "card.alt");
export const size = { width: CARD_SIZE.width, height: CARD_SIZE.height };
export const contentType = "image/png";

/**
 * Link preview card for /g/{slug} (PIN-102): Next's file convention
 * makes this the page's og:image (twitter-image.tsx reuses it). The
 * card is drawn in the board's skin with its latest pinned cut-outs;
 * a bad slug, a missing board or any render error still answers 200
 * with the generic card (src/server/board-card-image.tsx).
 */
export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }> | { slug: string };
}): Promise<Response> {
  const { slug } = await params;
  return boardCardImage(slug, {
    boards: getBoardRepository(),
    store: getDerivativeStore(),
    policyFor: (overrides) => getPolicy(overrides ?? null),
  });
}
