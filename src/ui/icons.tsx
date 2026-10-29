/**
 * Pinneds line icons (PIN-97): 24px grid, 2px round stroke, drawn in
 * currentColor. An icon is decoration next to a word; pass `title`
 * only when it stands alone with no other label.
 */
export const ICON_PATHS = {
  camera: ["M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.4-2h5l1.4 2h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z", "M15.5 12.5a3.5 3.5 0 1 1-7 0a3.5 3.5 0 1 1 7 0z"],
  pin: ["M16.5 8a4.5 4.5 0 1 1-9 0a4.5 4.5 0 1 1 9 0z", "M12 12.5V21"],
  scene: ["M6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4z", "M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 18", "M17 8.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z"],
  remix: ["M17 4l3 3-3 3", "M20 7H9a5 5 0 0 0-5 5", "M7 20l-3-3 3-3", "M4 17h11a5 5 0 0 0 5-5"],
  share: ["M12 3v12", "M8 7l4-4 4 4", "M5 12v6.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V12"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  plus: ["M12 5v14", "M5 12h14"],
  trash: ["M4 7h16", "M9.5 7V4.5h5V7", "M6.5 7l1 12.5A1.5 1.5 0 0 0 9 21h6a1.5 1.5 0 0 0 1.5-1.5l1-12.5"],
  people: ["M12.5 8a3.5 3.5 0 1 1-7 0a3.5 3.5 0 1 1 7 0z", "M2.5 20a6.5 6.5 0 0 1 13 0", "M15.5 4.6a3.5 3.5 0 0 1 0 6.8", "M18 14.2a6.5 6.5 0 0 1 3.5 5.8"],
  arrow: ["M5 12h14", "M13 6l6 6-6 6"],
  back: ["M19 12H5", "M11 6l-6 6 6 6"],
  cut: ["M8.5 6.5a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z", "M8.5 17.5a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z", "M8.2 7.7L20 18", "M8.2 16.3L20 6"],
  tap: ["M14 12a2 2 0 1 1-4 0a2 2 0 1 1 4 0z", "M19 12a7 7 0 1 1-14 0a7 7 0 1 1 14 0z"],
  undo: ["M9 14L4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
  more: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
  info: ["M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z", "M12 11v5.5", "M12 7.5h.01"],
  download: ["M12 4v11", "M7.5 10.5L12 15l4.5-4.5", "M5 19.5h14"],
  skin: ["M12 3.5c3.5 4 6 7.2 6 10.2a6 6 0 0 1-12 0c0-3 2.5-6.2 6-10.2z"],
  lock: ["M7.5 10.5h9A2.5 2.5 0 0 1 19 13v5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 18v-5a2.5 2.5 0 0 1 2.5-2.5z", "M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"],
} as const;

export type IconName = keyof typeof ICON_PATHS;
export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];

export function Icon({
  name,
  size = 24,
  strokeWidth = 2,
  title,
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  title?: string;
  className?: string;
}) {
  const labelled = Boolean(title);
  return (
    <svg
      className={className ? `pn-icon ${className}` : "pn-icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={labelled ? "img" : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
    >
      {ICON_PATHS[name].map((d, i) => (
        <path
          key={i}
          d={d}
          strokeWidth={name === "more" ? 3.2 : name === "info" && i === 2 ? 2.8 : undefined}
        />
      ))}
    </svg>
  );
}
