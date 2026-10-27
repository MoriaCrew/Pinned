import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { t } from "../../../i18n";
import { getGameRepository } from "../../../server/repository";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pinned game",
  robots: { index: false, follow: false },
};

function formatDeadline(value: number): string {
  // Server-rendered for every player, so use one explicit timezone.
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

export default async function GamePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const game = await getGameRepository().getGame(slug);
  if (!game) notFound();

  return (
    <main>
      <p className="eyebrow"><a href="/">Pinned</a></p>
      <p className="state-pill">{game.state}</p>
      <h1 className="page-title">{game.persona.name}</h1>
      <p className="tagline">{game.persona.judgingStyle}</p>

      <section className="card">
        <p className="eyebrow">{t("en", "game.challenge")}</p>
        <p className="challenge">“{game.challenge}”</p>
        <dl className="facts">
          <div>
            <dt>{t("en", "game.deadline")}</dt>
            <dd><time dateTime={new Date(game.deadlineAt).toISOString()}>{formatDeadline(game.deadlineAt)} UTC</time></dd>
          </div>
          <div>
            <dt>{t("en", "game.entries")}</dt>
            <dd>{game.entryCount}</dd>
          </div>
          <div>
            <dt>{t("en", "game.state")}</dt>
            <dd>{game.state}</dd>
          </div>
        </dl>
        <p className="notice">{t("en", "game.next")}</p>
      </section>

      <section className="card">
        <h2>{t("en", "game.rubricTitle")}</h2>
        <ul className="plain-list">
          <li>{t("en", "game.rubricFit")}</li>
          <li>{t("en", "game.rubricEffort")}</li>
          <li>{t("en", "game.rubricChaos")}</li>
        </ul>
        <p>{t("en", "game.rubricNote")}</p>
      </section>

      <section className="card">
        <h2>{t("en", "game.voice")}</h2>
        <ul className="plain-list">
          {game.persona.voiceRules.map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
        {game.persona.catchphrases.length > 0 ? (
          <>
            <h3>{t("en", "game.catchphrases")}</h3>
            <ul className="plain-list">
              {game.persona.catchphrases.map((phrase) => <li key={phrase}>{phrase}</li>)}
            </ul>
          </>
        ) : null}
      </section>
    </main>
  );
}
