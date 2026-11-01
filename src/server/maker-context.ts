import "server-only";
/**
 * The request's maker key for the free creations rule (PIN-205,
 * docs/15): the signed-in user when the caller resolves one, else
 * the client address from the rate-limit helper. A failing session
 * read falls back to the address — it never blocks creation.
 */
import { makerKey } from "../domain/maker-key";
import { clientIp } from "./rate-limit";
import { logServerError } from "./safe-log";

export async function requestMakerKey(
  request: Request,
  signedInUserId: (request: Request) => Promise<string | null>,
): Promise<string> {
  let userId: string | null = null;
  try {
    userId = await signedInUserId(request);
  } catch (error) {
    logServerError("maker session read failed", error);
  }
  return makerKey({ userId, clientIp: clientIp(request) });
}
