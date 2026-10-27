/**
 * Public origin for generated share links.
 *
 * A configured APP_BASE_URL that points at a real (non-loopback)
 * deployment always wins — share links must never be built from
 * request-controlled Host/forwarded headers an attacker can set.
 * Locally (loopback config) fall back to the proxy's forwarded
 * host/proto, then a usable Host header, so dev ports keep working.
 * Internal origins like 0.0.0.0:8080 are never used.
 */
function firstHeaderValue(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? "";
}

function validProtocol(value: string, fallback: string): string {
  return value === "http" || value === "https" ? value : fallback;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.startsWith("127.") ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function originFromHost(protocol: string, host: string): string | null {
  if (!host || /[\s/@?#]/.test(host)) return null;
  if (host.startsWith("0.0.0.0:") || host === "0.0.0.0") return null;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

function cleanFallback(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function getPublicOrigin(request: Request, fallbackBaseUrl?: string): string {
  const requestUrl = new URL(request.url);
  const fallbackProtocol = requestUrl.protocol.replace(/:$/, "");
  const forwardedProtocol = validProtocol(
    firstHeaderValue(request.headers.get("x-forwarded-proto")),
    fallbackProtocol,
  );

  const configured = cleanFallback(fallbackBaseUrl);
  if (configured && !isLoopbackHost(new URL(configured).hostname)) {
    return configured;
  }

  const forwarded = originFromHost(
    forwardedProtocol,
    firstHeaderValue(request.headers.get("x-forwarded-host")),
  );
  if (forwarded) return forwarded;

  const direct = originFromHost(
    forwardedProtocol,
    firstHeaderValue(request.headers.get("host")),
  );
  if (direct) return direct;

  return configured ?? requestUrl.origin;
}
