"use client";

import { useEffect } from "react";
import { urlWithoutDemoNotice, type DemoNotice as Notice } from "../domain/demo-ui";
import { t } from "../i18n";
import { useLocale } from "../i18n/client";

/**
 * The one-line answer when "See a board" could not make a board
 * (PIN-251): the demo route sends the visitor back with `?demo=busy`
 * (a Policy.demo cap) or `?demo=unavailable` (no template, or the
 * clone failed). Rendered from the flag like BoardDeletedNotice, and
 * the flag leaves the address bar at once, so a reload or a shared
 * link shows the plain landing. It carries no slug.
 */
export function DemoNotice({ notice }: { notice: Notice | null }) {
  const locale = useLocale();
  useEffect(() => {
    if (!notice) return;
    const next = urlWithoutDemoNotice(window.location.href);
    if (next !== null) window.history.replaceState(window.history.state, "", next);
  }, [notice]);
  if (!notice) return null;
  return (
    <p className="pn-lib-notice" role="status">
      {t(locale, notice === "busy" ? "landing.demoBusy" : "landing.demoUnavailable")}
    </p>
  );
}
