import type { Metadata } from "next";
import { getConfig } from "../../config";
import { t, tf } from "../../i18n";
import { getLocale } from "../../i18n/server";
import { getPolicy } from "../../policy/server";
import { ContactSection, LegalSection, LegalShell, SOURCE_URL, plural } from "../_legal/LegalParts";

// Runtime env (LEGAL_CONTACT_EMAIL, AUTH_MODE, PLUS_MODE, Policy
// overrides) decides parts of the text: render per request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return { title: tf(locale, "legal.pageTitle", { title: t(locale, "legal.privacyTitle") }) };
}

/**
 * Privacy (PIN-26). Plain language, and only what the shipped code
 * does: sources per claim are listed in the PR. Sign-in and payment
 * lines show only where this deploy turns them on.
 */
export default async function PrivacyPage() {
  const locale = await getLocale();
  const cfg = getConfig();
  const policy = getPolicy();
  const signIn = cfg.authMode === "optional";
  const payments = cfg.plusMode === "stripe";
  // Which calls send `store: false` (Policy sceneStore; samStore since PIN-213, unset = no flag sent).
  const noStore = [policy.samStore === false ? "cutting things out" : null, policy.sceneStore ? null : "making a scene"]
    .filter(Boolean)
    .join(" and ");
  return (
    <LegalShell locale={locale} title={t(locale, "legal.privacyTitle")} current="privacy">
      <LegalSection id="who" title="Who runs Pinneds">
        <p>
          Pinneds is a shared pinboard of real things, built by Moria Crew as a project for the Meta Global AI
          Developer Hackathon. Its code is open source under the GNU AGPL-3.0, so you can check what this page
          says: <a href={SOURCE_URL}>github.com/MoriaCrew/Pinned</a>. This page describes what the app does with
          your data today.
        </p>
      </LegalSection>

      <LegalSection id="collect" title="What we keep, and why">
        <ul>
          <li>
            <strong>Your photo.</strong> Your browser shrinks a photo before uploading it. Our server then makes a
            smaller working copy and strips its metadata (EXIF, such as location and camera details). The photo
            you uploaded is never stored: only the working copy, so you can tap to add things the AI missed. It
            is deleted when you pin your picks. If you leave without pinning, it can no longer be used after{" "}
            {plural(policy.workingCopyTtlHours, "hour")} and is deleted the next time anyone adds or pins a photo
            on that board; a storage rule deletes any copy still left after that.
          </li>
          <li>
            <strong>Cut-outs and scenes.</strong> Each thing cut out of your photo is stored as a picture, with a
            name the AI suggests and you can change. Scenes are stored as pictures too, with the idea that made
            them. They stay until they are deleted (see Your controls).
          </li>
          <li>
            <strong>What you type.</strong> Your name on each board, board titles, pin names and scene ideas. If
            you add a 4-digit number to switch phones, we keep it only in hashed form.
          </li>
          <li>
            <strong>Face reminder.</strong> The AI notes whether a photo shows a face. We keep that yes-or-no with
            each cut-out so the app can show a reminder (see People in photos).
          </li>
          {signIn ? (
            <li>
              <strong>Google sign-in (optional).</strong> If you sign in with Google, we keep a user id from
              Firebase (Google&apos;s sign-in service), your name and the link to your profile photo as Google
              shares them, the boards you join, and when. We never store your email address. You never need to
              sign in to use a board.
            </li>
          ) : null}
          <li>
            <strong>Usage logs.</strong> Each AI request is logged with ids (the board, your place on it, your
            user id if you are signed in, and the photo, scene or job), the kind of request, its size and an
            estimated cost. These logs hold no photos, cut-outs, ideas or AI replies. Each entry is set to be
            deleted {plural(policy.aiCallLogRetentionDays, "day")} after the request. We also count daily use
            per person and per board to apply fair-use limits.
          </li>
          <li>
            <strong>Abuse protection.</strong> To slow down abuse, the app counts requests per internet (IP)
            address. The counters we save hold a hash of the address, not the address itself.
            {policy.credits.enabled
              ? " To share free creations fairly, we also count the new boards each person starts, by a hash of their user id when signed in, else of their address."
              : null}{" "}
            Our hosting provider, Google Cloud, also keeps standard request logs.
          </li>
          {payments ? (
            <li>
              <strong>Payments.</strong> Board Plus is paid on Stripe&apos;s own checkout page. We never see or
              store your card number. We keep a record of each purchase (the board, the pack, the amount, its
              status and Stripe&apos;s ids for the payment, refunds and disputes) to add the creations and handle
              refunds. Stripe&apos;s privacy policy covers what you enter on its page.
            </li>
          ) : null}
        </ul>
      </LegalSection>

      <LegalSection id="ai" title="AI processing">
        <p>Pinneds uses Meta&apos;s AI models through Meta&apos;s model API. What each one receives:</p>
        <ul>
          <li>
            <strong>Muse Spark:</strong> the working copy of your photo, to name the things in it and notice
            faces; a thing you tap, to name it; and pin names, to suggest scene ideas.
          </li>
          <li>
            <strong>SAM 3.1:</strong> the working copy, to cut each thing out.
          </li>
          <li>
            <strong>Muse Image:</strong> the cut-outs picked for a scene, their names, the names of the people
            who pinned them and the idea (for a remix, also the scene being remixed), to make the scene.
          </li>
          <li>
            <strong>Muse Voice:</strong> a voice clip of up to {plural(policy.dictationMaxSeconds, "second")} when
            you dictate an idea, to turn it into text. We don&apos;t store the clip.
          </li>
        </ul>
        <p>
          We use Meta&apos;s API in its Standard mode, where Meta does not use this data to train its models. That
          does not mean Meta stores nothing: what Meta keeps, and for how long, is set by Meta&apos;s own terms.
          {noStore ? ` When ${noStore}, we also ask Meta not to store the request.` : null}
        </p>
        <p>
          AI can be wrong or say no: names, cut-outs and scenes are generated, and Meta&apos;s safety checks may
          turn down some photos or ideas.
        </p>
      </LegalSection>

      <LegalSection id="where" title="Where your data lives">
        <p>
          Pinneds runs on Google Cloud through Firebase: the app in Google&apos;s europe-west4 region (Netherlands)
          and the database in Firestore&apos;s eur3 location (Europe). Pictures are kept in Cloud Storage in the
          same Firebase project. Meta&apos;s model API{payments ? " and Stripe" : ""} handle requests on their own
          systems, which may be outside Europe.
        </p>
      </LegalSection>

      <LegalSection id="see" title="Who can see what">
        <p>
          There is no account wall on a board: anyone who has its link can open it, see its names, pins and
          scenes, and join it. Share a link only with people you trust. Board pages ask search engines not to
          index them. When a board link is pasted into a chat app, the app can show a preview picture made from
          the board&apos;s pins. Everyone on a board can use its pins in scenes, and each scene credits the people
          whose pins are in it.
        </p>
      </LegalSection>

      <LegalSection id="cookies" title="Cookies and browser storage">
        <p>
          Pinneds only uses the cookies it needs to work. There are no advertising or analytics cookies and no
          third-party trackers.
        </p>
        <dl className="pn-legal-cookies">
          <div>
            <dt>
              <code>pinned_player_…</code>
            </dt>
            <dd>Remembers who you are on one board. Kept {plural(policy.participantCookieDays, "day")}.</dd>
          </div>
          <div>
            <dt>
              <code>pinned_host_…</code>
            </dt>
            <dd>
              Marks the browser that started a board as its host. Sent only with that board&apos;s own requests.
              Kept {plural(policy.plus.hostCookieDays, "day")}.
            </dd>
          </div>
          {signIn ? (
            <div>
              <dt>
                <code>pinned_user</code>
              </dt>
              <dd>
                Keeps you signed in. Kept {plural(policy.userSessionDays, "day")}, or until you sign out.
              </dd>
            </div>
          ) : null}
          <div>
            <dt>
              <code>pinneds_locale</code>
            </dt>
            <dd>The language you picked, if you picked one. Kept {plural(policy.localeCookieDays, "day")}.</dd>
          </div>
        </dl>
        <p>
          The app also keeps a few small notes in your browser&apos;s storage, such as which tips you have seen or
          a checkout in progress. They stay on your device.
          {signIn ? " When you sign in, Google's sign-in library keeps its own sign-in state in your browser." : null}{" "}
          Google&apos;s sign-in window and Stripe&apos;s checkout page are run by Google and Stripe under their own
          cookie and privacy policies.
        </p>
      </LegalSection>

      <LegalSection id="controls" title="Your controls">
        <ul>
          <li>
            Rename or delete your own pins. Deleting one removes it from the board and hides the scenes that used
            it; its pictures are deleted once no board still uses it.
          </li>
          <li>Delete a scene you made. The board&apos;s host can delete any scene on the board.</li>
          <li>
            The board&apos;s host can delete the whole board. It disappears for everyone and its pictures are
            deleted. Some text records, such as names, stay in our database, but nothing in the app shows them
            again.
          </li>
          {signIn ? (
            <li>
              Signed in, you can remove a board from My boards, or sign out. There is no button to delete your
              account yet: <a href="#contact">contact us</a> and we will remove it.
            </li>
          ) : null}
          <li>
            For anything else, such as a copy of your data, a correction, or deleting something you can&apos;t
            reach, <a href="#contact">contact us</a>. Depending on where you live, the law may give you more
            rights over your data; contact us to use them.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="people" title="People in photos">
        <p>
          People are welcome in pins.
          {policy.faces === "note"
            ? " When the AI spots a face, the app reminds you to pin it only if the people in it are happy to be there. It never blocks the photo."
            : null}{" "}
          Ask before you upload a photo of someone else: anyone on the board can see their pin and use it in
          scenes.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes">
        <p>
          When this page changes, the date at the top changes too. Every version is public in the
          repository&apos;s history.
        </p>
      </LegalSection>

      <ContactSection email={cfg.legalContactEmail} />
    </LegalShell>
  );
}
