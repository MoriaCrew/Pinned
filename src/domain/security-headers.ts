/**
 * Baseline response headers for every route (PIN-212). Pure: no env
 * reads, no server imports — next.config.ts builds `headers()` from
 * this at build time, and a test pins each value.
 *
 * Why each one is what it is:
 * - HSTS: HTTPS only, subdomains too. No `preload`: that is a
 *   commitment the domain owner makes on purpose, not by default.
 * - X-Frame-Options SAMEORIGIN, not DENY: with AUTH_SAME_ORIGIN=1 the
 *   Firebase sign-in helper loads in a same-origin iframe from
 *   `/__/auth/iframe` (docs/13-auth.md).
 * - Referrer-Policy same-origin: a board link is a capability, so it
 *   must never leave the site in a Referer header.
 * - Permissions-Policy: dictation needs the microphone on our own
 *   pages; nothing uses geolocation, and payment is a redirect to
 *   Stripe's hosted Checkout, not a Payment Request on our page. The
 *   photo picker's `capture` input is a file chooser, not
 *   getUserMedia, so `camera` stays off.
 * - No CSP yet: a policy that fits Next's inline scripts, Firebase
 *   auth and Stripe needs its own issue and a hosted soak.
 */

export interface SecurityHeader {
  key: string;
  value: string;
}

const SECONDS_PER_DAY = 24 * 60 * 60;

export function securityHeaders(input: { hstsMaxAgeDays: number }): SecurityHeader[] {
  return [
    {
      key: "Strict-Transport-Security",
      value: `max-age=${input.hstsMaxAgeDays * SECONDS_PER_DAY}; includeSubDomains`,
    },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Referrer-Policy", value: "same-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=()" },
  ];
}
