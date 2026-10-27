/**
 * Public origin for generated share links.
 *
 * App Hosting/Cloud Run can expose an internal request origin such
 * as 0.0.0.0:8080. Prefer the proxy's forwarded public host/proto,
 * then a usable Host header, then the configured APP_BASE_URL.
 */
function firstHeaderValue(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? "";
}

function validProtocol(value: string, fallback: string): string {
  return value === "http" || value === "https" ? value : fallback;
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

  const forwarded = originFromHost(
    forwardedProtocol,
    firstHeaderValue(request.headers.get("x-forwarded-host")),
  );
  if (forwarded) return forwarded;

  const direct = originFromHost(
    fallbackProtocol,
    firstHeaderValue(request.headers.get("host")),
  );
  if (direct) return direct;

  return cleanFallback(fallbackBaseUrl) ?? requestUrl.origin;
}
