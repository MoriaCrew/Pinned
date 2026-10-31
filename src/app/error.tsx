"use client";

import { useRouter } from "next/navigation";
import { startTransition } from "react";
import { useLocale } from "../i18n/client";
import { ErrorScreen } from "./ErrorScreen";

/**
 * Error boundary for every page (PIN-212): a render that throws, say
 * a Firestore blip, lands here instead of on Next's bare "Application
 * error". It renders inside the root layout, so the visitor's
 * language is available.
 *
 * Retry is `reset()` plus a router refresh: most of our errors come
 * from server components, and `reset()` alone re-renders the same
 * failed server payload.
 *
 * The error itself is deliberately unused: its message and digest
 * stay out of the page (the server already logged them).
 */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const locale = useLocale();
  const router = useRouter();
  const retry = () => {
    startTransition(() => {
      router.refresh();
      reset();
    });
  };
  return <ErrorScreen locale={locale} onRetry={retry} />;
}
