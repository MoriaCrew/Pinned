import type { Metadata } from "next";
import { getConfig } from "../../config";
import { formatEur } from "../../domain/makes-ui";
import { DEFAULT_LOCALE, t, tf } from "../../i18n";
import { getLocale } from "../../i18n/server";
import { getPolicy } from "../../policy/server";
import { ContactSection, LegalSection, LegalShell, SOURCE_URL, plural } from "../_legal/LegalParts";

// Runtime env (LEGAL_CONTACT_EMAIL, PLUS_MODE, Policy overrides)
// decides parts of the text: render per request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return { title: tf(locale, "legal.pageTitle", { title: t(locale, "legal.termsTitle") }) };
}

/**
 * Terms of use (PIN-26). Board Plus is described from the one Policy
 * pack the Plus sheet sells (`credits.packs[0]`, docs/15) and its
 * refund/dispute handling as shipped: creations are clawed back,
 * nothing stronger is promised.
 */
export default async function TermsPage() {
  const locale = await getLocale();
  const cfg = getConfig();
  const pack = getPolicy().credits.packs[0];
  const takedown = plural(getPolicy().takedownHours, "hour");
  return (
    <LegalShell locale={locale} title={t(locale, "legal.termsTitle")} current="terms">
      <LegalSection id="about" title="About these terms">
        <p>
          These terms cover your use of Pinneds, a hackathon project by Moria Crew. By using Pinneds you agree to
          them. The <a href="/privacy">Privacy</a> page explains what happens to your data.
        </p>
      </LegalSection>

      <LegalSection id="use" title="Using Pinneds">
        <ul>
          <li>
            A board&apos;s link is its invitation: anyone with it can open the board and join. Share it only with
            people you trust.
          </li>
          <li>
            You are responsible for what you upload and write. Only upload photos you have the right to share,
            and ask people before you pin them. Nothing illegal, hateful or sexual.
          </li>
          <li>Don&apos;t misuse Pinneds: no attempts to break it, overload it or get around its limits.</li>
          <li>
            The AI can refuse a photo or an idea, and it makes mistakes: a name can be wrong, a cut-out can miss,
            a scene may not match your idea.
          </li>
          <li>Scenes are made by AI (Muse Image) and credit the people whose pins are in them.</li>
          <li>We may remove content or boards that break these terms.</li>
        </ul>
      </LegalSection>

      <LegalSection id="content" title="Your content">
        <ul>
          <li>You keep the rights to what you upload and write.</li>
          <li>
            By pinning something on a board, you let that board&apos;s members see it and use it in scenes and
            remixes, and you let us store and process it, including with the AI models named on the Privacy
            page, to run Pinneds.
          </li>
          <li>Deleting your pin removes it from the board and hides the scenes that used it.</li>
          <li>
            Daily limits apply to photos, scenes and voice ideas, to keep Pinneds fair and within its budget.
            When the AI budget runs out, a scene comes out as a simple collage instead.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="plus" title="Board Plus">
        {cfg.plusMode === "off" ? (
          <p>Board Plus is not on sale on this site right now. If it opens, these terms apply to it.</p>
        ) : null}
        {cfg.plusMode === "mock" ? <p>This site runs a demo checkout: nothing is charged.</p> : null}
        {pack ? (
          <ul>
            <li>
              Board Plus is a one-time purchase for one board: {formatEur(pack.eurCents, DEFAULT_LOCALE)} for Board
              Plus and {plural(pack.credits, "creation")}. Plus gives the board every look and foil stickers on its
              favourite pins.
            </li>
            <li>
              A creation is one photo cut out by AI or one AI-made scene. Collages and failed or refused attempts
              don&apos;t use one. Bought creations don&apos;t expire, but they belong to the board: if the board is
              deleted, they go with it.
            </li>
            <li>
              Anyone on the board, or its host, can buy it. It is for the whole board, shared with everyone on it,
              and does not carry over to other boards.
            </li>
            <li>
              Payment is handled by Stripe. Prices are shown in euros and are the full price; you may be charged
              in your local currency.
            </li>
            <li>
              Refunds: to ask for one, <a href="#contact">contact us</a> with the date and amount of the payment. If
              a payment is refunded, the creations it added are taken off the board in proportion to the refund;
              any already used come off creations the board gets later. If you dispute a payment with your bank,
              those creations are on hold until the dispute ends, and are taken off if the bank sides with you.
            </li>
          </ul>
        ) : null}
      </LegalSection>

      <LegalSection id="warranty" title="No warranty">
        <p>
          Pinneds is a hackathon project, provided as it is, with no warranty. It may change, break, lose data or
          shut down, so keep your own copies of anything that matters. As far as the law allows, Moria Crew is not
          liable for losses that come from using it.
        </p>
      </LegalSection>

      <LegalSection id="source" title="Open source">
        <p>
          The code of Pinneds is open source under the GNU AGPL-3.0:{" "}
          <a href={SOURCE_URL}>github.com/MoriaCrew/Pinned</a>. The licence covers the code; these terms cover
          this website.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes">
        <p>
          We may update these terms. The date at the top changes when we do, and every version is public in the
          repository&apos;s history. If you keep using Pinneds after a change, the new terms apply.
        </p>
      </LegalSection>

      <LegalSection id="law" title="Governing law">
        <p>These terms are governed by the laws of the country where Moria Crew is established.</p>
      </LegalSection>

      <LegalSection id="report" title="Reporting abuse and takedowns">
        <ul>
          <li>
            To report illegal or abusive content, use &quot;Report this board&quot; at the foot of the board page
            or email us at the contact address below. The report carries a board reference, never the board
            link itself.
          </li>
          <li>
            When a report shows content breaking these terms or the law, we remove it within {takedown} of
            confirming it. The same address is our abuse contact for anything urgent.
          </li>
          <li>Please describe what to look at in words; never attach or forward illegal images.</li>
        </ul>
      </LegalSection>

      <ContactSection email={cfg.legalContactEmail} />
    </LegalShell>
  );
}
