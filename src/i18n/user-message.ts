import { DEFAULT_LOCALE, tf, type Locale, type MessageKey } from "./index";
import en from "./messages/en.json";

export type MessageValues = Readonly<Record<string, string | number>>;

/**
 * A user-facing line kept as a catalog key + values (PIN-196), so it
 * is translated into the reader's language when it reaches them,
 * never frozen in English when it is made.
 */
export interface UserMessage {
  readonly key: MessageKey;
  readonly values?: MessageValues;
}

export function userMessage(key: MessageKey, values?: MessageValues): UserMessage {
  return values ? { key, values } : { key };
}

export function translateMessage(locale: Locale, message: UserMessage): string {
  return tf(locale, message.key, message.values ?? {});
}

/** English text: for logs and `Error.message`, never what a user reads. */
export function englishText(message: UserMessage | string): string {
  return typeof message === "string" ? message : translateMessage(DEFAULT_LOCALE, message);
}

/** An error whose user-facing line is a catalog key (see the server error classes). */
export interface LocalizableError extends Error {
  readonly userMessage?: UserMessage;
}

/** The error's line in `locale`; plain-string errors keep their text. */
export function localizedErrorText(error: LocalizableError, locale: Locale): string {
  return error.userMessage ? translateMessage(locale, error.userMessage) : error.message;
}

/** True for a stored value that is a catalog key rather than legacy English text. */
export function isMessageKey(value: string): value is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, value);
}
