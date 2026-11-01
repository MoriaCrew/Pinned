"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icons";
import { Button, cx } from "./primitives";

/** Enter sends; Shift+Enter is a new line; never while an IME is composing (229: Safari's composing key). */
export function isSubmitKey(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

/**
 * Chat-style composer (PIN-216): a field that grows from one line to
 * four, then scrolls, with a tool inside on the right (the mic) and a
 * labelled send button beside it. Enter sends when allowed. `overlay`
 * (a recording line) covers the field without resizing it; `error`
 * and `count` share one small line underneath; `status` is spoken
 * only. A new `flashKey` briefly highlights the field.
 */
export function Composer({
  id,
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  submitLabel,
  onSubmit,
  submitDisabled,
  tool,
  overlay,
  error,
  count,
  status,
  flashKey = 0,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  submitLabel: string;
  onSubmit: () => void;
  submitDisabled?: boolean;
  tool?: ReactNode;
  overlay?: ReactNode;
  error?: string | null;
  count?: string | null;
  status?: string;
  flashKey?: number;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const footId = `${id}-foot`;
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [value]);
  return (
    <div className={cx("pn-composer", className)}>
      <div className="pn-composer-row">
        <div className="pn-composer-field">
          {flashKey ? <span key={flashKey} className="pn-composer-flash" aria-hidden="true" /> : null}
          <label className="pn-sr" htmlFor={id}>
            {label}
          </label>
          <textarea
            ref={ref}
            id={id}
            className="pn-composer-input"
            rows={1}
            value={value}
            placeholder={placeholder}
            maxLength={maxLength}
            readOnly={Boolean(overlay)}
            autoComplete="off"
            enterKeyHint="send"
            aria-describedby={error || count ? footId : undefined}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              const { key, shiftKey, keyCode } = event;
              if (!isSubmitKey({ key, shiftKey, keyCode, isComposing: event.nativeEvent.isComposing })) return;
              event.preventDefault();
              if (!submitDisabled) onSubmit();
            }}
          />
          {overlay ? <div className="pn-composer-overlay">{overlay}</div> : null}
          {tool ? <span className="pn-composer-tool">{tool}</span> : null}
        </div>
        <Button variant="primary" size="lg" className="pn-composer-send" disabled={submitDisabled} onClick={onSubmit}>
          {submitLabel}
        </Button>
      </div>
      {error || count ? (
        <p className="pn-composer-foot" id={footId}>
          {error ? (
            <span className="pn-field-error" role="alert">
              <Icon name="info" size={16} />
              {error}
            </span>
          ) : (
            <span />
          )}
          {count ? <span className="pn-field-count">{count}</span> : null}
        </p>
      ) : null}
      <span className="pn-sr" role="status">
        {status}
      </span>
    </div>
  );
}
