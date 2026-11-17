const PATHS = {
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 012-2h9" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  download: <><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5" /><path d="M5 19h14" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chat: <path d="M5 5h14v10H10l-5 4V5z" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>,
  add: <><path d="M6 4h9l4 4v12H6z" /><path d="M12 11v6M9 14h6" /></>,
  print: <><path d="M7 9V4h10v5" /><rect x="4" y="9" width="16" height="8" rx="2" /><path d="M7 14h10v6H7z" /></>,
  speak: <><path d="M4 10v4h3l5 4V6L7 10H4z" /><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></>,
  history: <><path d="M4 12a8 8 0 108-8 8 8 0 00-6.3 3" /><path d="M4 4v4h4M12 8v4.5l3 2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M5 5l1.8 1.8M17.2 17.2L19 19M5 19l1.8-1.8M17.2 6.8L19 5" /></>,
  moon: <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />,
  retry: <><path d="M20 12a8 8 0 11-2.6-5.9" /><path d="M20 4v5h-5" /></>,
};

export default function Icon({ name, size = 16 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
