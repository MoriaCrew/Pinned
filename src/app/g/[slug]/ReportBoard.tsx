"use client";

import { reportBoardHref } from "../../../domain/board-report";
import { t, tf } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import styles from "./board.module.css";

/**
 * "Report this board" (PIN-239): a quiet link at the foot of every
 * board page, for visitors too (no join needed). It opens a mail to
 * the legal contact carrying only the board's opaque report
 * reference — never the slug — so reporting illegal or abusive
 * content never spreads the board link. Without a configured
 * address it points at the Terms contact section instead, and
 * without a reference (renders that predate PIN-239) it is absent.
 */
export function ReportBoardLink({
  email,
  reportRef,
}: {
  email?: string | null;
  reportRef?: string | null;
}) {
  const locale = useLocale();
  if (!reportRef) return null;
  const href =
    reportBoardHref(
      email,
      reportRef,
      tf(locale, "board.reportSubject", { ref: reportRef }),
      tf(locale, "board.reportBody", { ref: reportRef }),
    ) ?? "/terms#contact";
  return (
    <footer className={styles.reportFoot}>
      <a href={href}>{t(locale, "board.report")}</a>
    </footer>
  );
}
