import type { ReactNode } from "react";

export type IconName =
  | "play"
  | "pause"
  | "stop"
  | "terminal"
  | "trash"
  | "plus"
  | "refresh"
  | "x"
  | "copy"
  | "check"
  | "box"
  | "workspace"
  | "activity"
  | "settings"
  | "external"
  | "chevron"
  | "search"
  | "key"
  | "alert"
  | "cpu"
  | "disk"
  | "clock"
  | "server"
  | "arrow"
  | "arrow-left"
  | "file-plus"
  | "upload"
  | "download"
  | "folder"
  | "file"
  | "save"
  | "globe"
  | "monitor"
  | "camera"
  | "fork"
  | "restore"
  | "webhook"
  | "lock"
  | "sun"
  | "moon"
  | "list"
  | "book"
  | "info";

const paths: Record<IconName, ReactNode> = {
  play: <path d="M6 4.5 12.5 8 6 11.5V4.5Z" />,
  pause: (
    <>
      <path d="M6.5 4.5v7" />
      <path d="M11.5 4.5v7" />
    </>
  ),
  stop: <rect x="5.2" y="5.2" width="5.6" height="5.6" rx="1.2" />,
  terminal: (
    <>
      <path d="m4.5 5 3 3-3 3" />
      <path d="M9.5 11h4" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 5.5h9" />
      <path d="M6.5 5.5V4h3v1.5" />
      <path d="M5.5 5.5 6 13h5l.5-7.5" />
    </>
  ),
  plus: (
    <>
      <path d="M8 3.5v9" />
      <path d="M3.5 8h9" />
    </>
  ),
  refresh: (
    <>
      <path d="M12.8 7.2A5 5 0 1 0 13 9" />
      <path d="M13.2 3.8v3.4h-3.4" />
    </>
  ),
  x: (
    <>
      <path d="m4.5 4.5 7 7" />
      <path d="m11.5 4.5-7 7" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="7" height="7" rx="1.4" />
      <path d="M10.5 5.5V4.2A1.2 1.2 0 0 0 9.3 3H4.2A1.2 1.2 0 0 0 3 4.2v5.1a1.2 1.2 0 0 0 1.2 1.2h1.3" />
    </>
  ),
  check: <path d="m3.8 8.4 2.8 2.8 5.6-6.4" />,
  box: (
    <>
      <rect x="3" y="4" width="10" height="8.5" rx="1.5" />
      <path d="M5.5 7h5" />
      <path d="M5.5 9.3h3" />
    </>
  ),
  workspace: (
    <>
      <rect x="3" y="3.5" width="4.2" height="4.2" rx="1" />
      <rect x="8.8" y="3.5" width="4.2" height="4.2" rx="1" />
      <rect x="3" y="8.8" width="4.2" height="4.2" rx="1" />
      <rect x="8.8" y="8.8" width="4.2" height="4.2" rx="1" />
    </>
  ),
  activity: <path d="M2.5 8.5h2.3l1.5-4 3.1 7.5 1.7-3.5h2.4" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 2.8v1.4M8 11.8v1.4M2.8 8h1.4M11.8 8h1.4M4.3 4.3l1 1M10.7 10.7l1 1M11.7 4.3l-1 1M5.3 10.7l-1 1" />
    </>
  ),
  external: (
    <>
      <path d="M9 3.5h3.5V7" />
      <path d="m12.5 3.5-5 5" />
      <path d="M11.5 9.5v2A1.5 1.5 0 0 1 10 13H4.5A1.5 1.5 0 0 1 3 11.5V6a1.5 1.5 0 0 1 1.5-1.5h2" />
    </>
  ),
  chevron: <path d="m6 3.8 4.2 4.2L6 12.2" />,
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="3.7" />
      <path d="m10 10 3 3" />
    </>
  ),
  key: (
    <>
      <circle cx="5.8" cy="8.2" r="2.6" />
      <path d="m7.8 7 4.7-4.7M10.3 4.5l1.6 1.6M11.8 3l1.6 1.6" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.8 14 13H2L8 2.8Z" />
      <path d="M8 6.5v3" />
      <path d="M8 11.4h.01" />
    </>
  ),
  cpu: (
    <>
      <rect x="4.3" y="4.3" width="7.4" height="7.4" rx="1.5" />
      <path d="M6.5 2.5v1.8M9.5 2.5v1.8M6.5 11.7v1.8M9.5 11.7v1.8M2.5 6.5h1.8M2.5 9.5h1.8M11.7 6.5h1.8M11.7 9.5h1.8" />
    </>
  ),
  disk: (
    <>
      <ellipse cx="8" cy="4.5" rx="4.6" ry="1.8" />
      <path d="M3.4 4.5v6.8c0 1 2 1.8 4.6 1.8s4.6-.8 4.6-1.8V4.5" />
      <path d="M3.4 7.8c0 1 2 1.8 4.6 1.8s4.6-.8 4.6-1.8" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.3" />
      <path d="M8 5v3.2l2 1.2" />
    </>
  ),
  server: (
    <>
      <rect x="2.8" y="3.2" width="10.4" height="4" rx="1.2" />
      <rect x="2.8" y="8.8" width="10.4" height="4" rx="1.2" />
      <path d="M5 5.2h.01M5 10.8h.01" />
    </>
  ),
  arrow: (
    <>
      <path d="M3 8h9" />
      <path d="m9 4.8 3.2 3.2L9 11.2" />
    </>
  ),
  "arrow-left": (
    <>
      <path d="M13 8H4" />
      <path d="m7 4.8-3.2 3.2L7 11.2" />
    </>
  ),
  "file-plus": (
    <>
      <path d="M9 2.8H4.8A1.3 1.3 0 0 0 3.5 4.1v8.1a1.3 1.3 0 0 0 1.3 1.3h6.4a1.3 1.3 0 0 0 1.3-1.3V5.8L9 2.8Z" />
      <path d="M9 2.8v3h3.5" />
      <path d="M8 8v3M6.5 9.5h3" />
    </>
  ),
  upload: (
    <>
      <path d="M8 10.5V3" />
      <path d="m5.2 5.6 2.8-2.8 2.8 2.8" />
      <path d="M3.2 10v2a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2v-2" />
    </>
  ),
  download: (
    <>
      <path d="M8 3v7.5" />
      <path d="m5.2 8 2.8 2.8L10.8 8" />
      <path d="M3.2 10v2a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2v-2" />
    </>
  ),
  folder: (
    <path d="M2.8 4.4A1.2 1.2 0 0 1 4 3.2h2.2l1.2 1.4h4.6A1.2 1.2 0 0 1 13.2 5.8v6A1.2 1.2 0 0 1 12 13H4a1.2 1.2 0 0 1-1.2-1.2V4.4Z" />
  ),
  file: (
    <>
      <path d="M9.2 2.8H4.6a1.2 1.2 0 0 0-1.2 1.2v8a1.2 1.2 0 0 0 1.2 1.2h6.8a1.2 1.2 0 0 0 1.2-1.2V5.6L9.2 2.8Z" />
      <path d="M9.2 2.8v2.8h3.4" />
    </>
  ),
  save: (
    <>
      <path d="M3.2 3.8A1.3 1.3 0 0 1 4.5 2.5h6.2l2.8 2.8v7.4a1.3 1.3 0 0 1-1.3 1.3H4.5a1.3 1.3 0 0 1-1.3-1.3V3.8Z" />
      <path d="M5.4 2.8v3.4h5V2.8M5.2 13.2V9.6h5.6v3.6" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8.3" r="5.1" />
      <path d="M2.9 8.3h10.2M8 3.2c2.8 2.9 2.8 7.3 0 10.2M8 3.2c-2.8 2.9-2.8 7.3 0 10.2" />
    </>
  ),
  monitor: (
    <>
      <rect x="2.4" y="3" width="11.2" height="7.4" rx="1.2" />
      <path d="M6 13h4M8 10.4V13" />
    </>
  ),
  camera: (
    <>
      <path d="M2.6 5.2h2l1-1.6h4.8l1 1.6h2a1.2 1.2 0 0 1 1.2 1.2v5.4a1.2 1.2 0 0 1-1.2 1.2H2.6a1.2 1.2 0 0 1-1.2-1.2V6.4a1.2 1.2 0 0 1 1.2-1.2Z" />
      <circle cx="8" cy="8.9" r="2" />
    </>
  ),
  fork: (
    <>
      <circle cx="4.4" cy="3.8" r="1.5" />
      <circle cx="11.6" cy="3.8" r="1.5" />
      <circle cx="8" cy="12.2" r="1.5" />
      <path d="M4.4 5.3v1.2a2 2 0 0 0 2 2h3.2a2 2 0 0 0 2-2V5.3M8 8.5v2.2" />
    </>
  ),
  restore: (
    <>
      <path d="M12.7 7.2A4.9 4.9 0 1 0 13 8.8" />
      <path d="M13 3.8v3.3H9.7" />
    </>
  ),
  webhook: (
    <>
      <circle cx="4.2" cy="5" r="1.6" />
      <circle cx="11.8" cy="5" r="1.6" />
      <circle cx="8" cy="12.4" r="1.6" />
      <path d="M5.4 6.3 7 10.8M10.6 6.3 9 10.8M5.8 5h4.4" />
    </>
  ),
  lock: (
    <>
      <rect x="3.6" y="7" width="8.8" height="6.2" rx="1.3" />
      <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" />
    </>
  ),
  moon: <path d="M12.8 9.4A5.4 5.4 0 0 1 6.6 3.2 5.3 5.3 0 1 0 12.8 9.4Z" />,
  list: (
    <>
      <path d="M5.5 4.2h8M5.5 8h8M5.5 11.8h8" />
      <path d="M2.8 4.2h.01M2.8 8h.01M2.8 11.8h.01" />
    </>
  ),
  book: (
    <>
      <path d="M2.8 3.2h3.4A1.8 1.8 0 0 1 8 5v7.8a1.5 1.5 0 0 0-1.5-1.5H2.8V3.2Z" />
      <path d="M13.2 3.2H9.8A1.8 1.8 0 0 0 8 5v7.8a1.5 1.5 0 0 1 1.5-1.5h3.7V3.2Z" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 7.2v3.2M8 5.2h.01" />
    </>
  ),
};

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
