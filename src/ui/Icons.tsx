// Line icons on a 16 px grid, drawn with currentColor.

type P = { size?: number; className?: string };

const svg = (size: number, className: string | undefined, children: React.ReactNode, fill = false) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill={fill ? "currentColor" : "none"}
    stroke={fill ? "none" : "currentColor"}
    strokeWidth="1.25"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const Files = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <path d="M4 1.8h5l3.2 3.2v8.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z" />
    <path d="M9 1.8V5h3.2" />
  </>);

export const Search = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <circle cx="7" cy="7" r="4.2" />
    <path d="m10.2 10.2 3.6 3.6" />
  </>);

export const Branch = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <circle cx="4.5" cy="3.5" r="1.6" />
    <circle cx="4.5" cy="12.5" r="1.6" />
    <circle cx="11.5" cy="5.5" r="1.6" />
    <path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-2.2 3-4.6 3.6-1.3.3-2 .8-2.3 1.6" />
  </>);

export const Checklist = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <path d="m2.5 4 1.2 1.2L6 3M2.5 9.5l1.2 1.2L6 8.5" />
    <path d="M8 4.2h5.5M8 9.7h5.5M8 13.2h5.5" />
  </>);

export const Agents = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <circle cx="8" cy="5" r="2.3" />
    <path d="M3.5 13.5c.6-2.6 2.3-4 4.5-4s3.9 1.4 4.5 4" />
    <circle cx="2.8" cy="7" r="1.3" />
    <circle cx="13.2" cy="7" r="1.3" />
  </>);

export const Terminal = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
    <path d="m4.5 6 2 2-2 2M8.5 10.5h3" />
  </>);

export const Chat = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H7l-3 2.5v-2.5h-.5a1 1 0 0 1-1-1Z" />
  </>);

export const Sparkle = ({ size = 16, className }: P) =>
  svg(size, className, <path d="M8 1.5c.4 3.2 1.6 4.6 5 5-3.4.6-4.6 1.8-5 5-.4-3.2-1.6-4.4-5-5 3.4-.4 4.6-1.8 5-5Z" />, true);

export const User = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <circle cx="8" cy="5.5" r="2.6" />
    <path d="M3 14c.5-3 2.4-4.6 5-4.6S12.5 11 13 14" />
  </>);

export const Play = ({ size = 16, className }: P) => svg(size, className, <path d="M4.5 2.8v10.4L13 8Z" />, true);
export const Pause = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <rect x="3.5" y="2.8" width="3" height="10.4" rx=".6" />
    <rect x="9.5" y="2.8" width="3" height="10.4" rx=".6" />
  </>, true);
export const StepBack = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <path d="M12 3v10L5.5 8Z" />
    <rect x="3" y="3" width="1.6" height="10" rx=".5" />
  </>, true);
export const StepFwd = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <path d="M4 3v10l6.5-5Z" />
    <rect x="11.4" y="3" width="1.6" height="10" rx=".5" />
  </>, true);
export const TurnBack = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <path d="M8.5 3v10L2.5 8ZM14 3v10L8 8Z" />
  </>, true);
export const TurnFwd = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <path d="M7.5 3v10l6-5ZM2 3v10l6-5Z" />
  </>, true);

export const Folder = ({ size = 16, className, open }: P & { open?: boolean }) =>
  svg(size, className, open ? (
    <path d="M1.8 12.5V4a1 1 0 0 1 1-1h3.3l1.5 1.5h5.6a1 1 0 0 1 1 1V6.5M1.8 12.5l1.6-5a1 1 0 0 1 1-.7h10a.6.6 0 0 1 .6.8l-1.4 4.6a1 1 0 0 1-1 .7H2.8a1 1 0 0 1-1-.9Z" />
  ) : (
    <path d="M1.8 4a1 1 0 0 1 1-1h3.3l1.5 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1Z" />
  ));

export const Chevron = ({ size = 12, className, open }: P & { open?: boolean }) =>
  svg(size, className, <path d={open ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"} />);

export const Dot = ({ size = 8, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 8 8" className={className} aria-hidden="true">
    <circle cx="4" cy="4" r="3.2" fill="currentColor" />
  </svg>
);

export const Commit = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <circle cx="8" cy="8" r="2.6" />
    <path d="M1.5 8h3.9M10.6 8h3.9" />
  </>);
export const ArrowUp = ({ size = 16, className }: P) => svg(size, className, <path d="M8 13V3M4 7l4-4 4 4" />);
export const ArrowDown = ({ size = 16, className }: P) => svg(size, className, <path d="M8 3v10M4 9l4 4 4-4" />);
export const Globe = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c1.8 1.8 2.6 3.8 2.6 6S9.8 12.2 8 14C6.2 12.2 5.4 10.2 5.4 8S6.2 3.8 8 2Z" />
  </>);
export const Plug = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <path d="M6 1.8v3M10 1.8v3M4.5 4.8h7v3a3.5 3.5 0 0 1-7 0ZM8 11.3v3" />
  </>);
export const Eye = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
  </>);
export const Pencil = ({ size = 16, className }: P) =>
  svg(size, className, <path d="M10.8 2.5 13.5 5.2 5.6 13.1H2.9v-2.7ZM9.3 4l2.7 2.7" />);
export const FilePlus = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <path d="M9 1.8H4a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V5Z" />
    <path d="M7.6 7.2v4M5.6 9.2h4" />
  </>);
export const Question = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M8 11.6v.1" />
  </>);
export const Bolt = ({ size = 16, className }: P) => svg(size, className, <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8Z" />);
export const Stop = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <circle cx="8" cy="8" r="6" />
    <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
  </>);
export const Layers = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <path d="m8 2 6 3-6 3-6-3Z" />
    <path d="m2 8 6 3 6-3M2 11l6 3 6-3" />
  </>);
export const Close = ({ size = 12, className }: P) => svg(size, className, <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />);
export const PanelBottom = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.2" />
    <path d="M1.8 9.5h12.4" />
  </>);
export const PanelLeft = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.2" />
    <path d="M6 2.5v11" />
  </>);
export const PanelRight = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.2" />
    <path d="M10 2.5v11" />
  </>);
export const Timeline = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <path d="M1.8 10.5h12.4" />
    <path d="M3.5 8.5v4M6 9.3v2.4M8.5 7v7M11 9.3v2.4M13 8.5v4" />
    <circle cx="8.5" cy="4" r="1.6" />
  </>);
export const Live = ({ size = 16, className }: P) =>
  svg(size, className, <>
    <circle cx="8" cy="8" r="2" fill="currentColor" />
    <path d="M4.5 4.5a5 5 0 0 0 0 7M11.5 4.5a5 5 0 0 1 0 7" />
  </>);

/** The icon for a step, by what it does. */
export function StepIcon({ cat, kind, size = 14 }: { cat: string; kind: string; size?: number }) {
  if (kind === "prompt") return <User size={size} />;
  if (kind === "say") return <Sparkle size={size} />;
  if (kind === "interrupt") return <Stop size={size} />;
  if (kind === "compact") return <Layers size={size} />;
  switch (cat) {
    case "read":
      return <Eye size={size} />;
    case "edit":
      return <Pencil size={size} />;
    case "write":
      return <FilePlus size={size} />;
    case "shell":
      return <Terminal size={size} />;
    case "git":
      return <Branch size={size} />;
    case "search":
      return <Search size={size} />;
    case "web":
      return <Globe size={size} />;
    case "agent":
      return <Agents size={size} />;
    case "task":
      return <Checklist size={size} />;
    case "ask":
      return <Question size={size} />;
    case "mcp":
      return <Plug size={size} />;
    default:
      return <Bolt size={size} />;
  }
}
