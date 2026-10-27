"use client";

import { useEffect, useState } from "react";

/** Deadline in the viewer's own timezone (never raw UTC clock time). */
export function LocalDeadline({ value }: { value: number }) {
  const [text, setText] = useState(() =>
    new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(value),
  );
  useEffect(() => {
    setText(
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(value),
    );
  }, [value]);
  return <time dateTime={new Date(value).toISOString()}>{text}</time>;
}
