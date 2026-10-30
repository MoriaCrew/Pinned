"use client";

import { useState } from "react";
import { t } from "../../i18n";
import { Button, type ButtonSize, type ButtonVariant } from "../../ui";
import { useAuth } from "./AuthProvider";

/**
 * The one "Sign in" action (PIN-84 logic, PIN-104 look): quiet in
 * the header, primary on the My boards / My pins sign-in states.
 * One line under or beside it says what to do when sign-in fails.
 */
export function SignInButton({
  variant = "quiet",
  size = "md",
  stacked,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Error line goes under the button (page states) instead of beside it (header). */
  stacked?: boolean;
}) {
  const { signInError, signIn } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <span className="pn-lib-signin" data-stacked={stacked ? "" : undefined}>
      {signInError ? (
        <span className="pn-lib-signin-error" role="alert">
          {t("en", "auth.failed")}
        </span>
      ) : null}
      <Button
        variant={variant}
        size={size}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void signIn().finally(() => setBusy(false));
        }}
      >
        {busy ? t("en", "auth.signingIn") : t("en", "auth.signIn")}
      </Button>
    </span>
  );
}
