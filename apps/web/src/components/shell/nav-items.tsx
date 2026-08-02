/**
 * Navigation model, shared by the desktop sidebar and the mobile tab bar so the
 * two can never fall out of sync. Icons are inline strokes — no icon package.
 */

type IconProps = { className?: string };

const stroke = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function DashboardIcon({ className }: IconProps) {
  return (
    <svg {...stroke} className={className} aria-hidden>
      <path d="M4 17l5-5 3.5 3L20 7" />
      <path d="M4 20h16" />
    </svg>
  );
}

function PortfoliosIcon({ className }: IconProps) {
  return (
    <svg {...stroke} className={className} aria-hidden>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10h18M8 6V4.5" />
    </svg>
  );
}

function ExpensesIcon({ className }: IconProps) {
  return (
    <svg {...stroke} className={className} aria-hidden>
      <path d="M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8z" />
      <path d="M9.5 8.5h5M9.5 12.5h5" />
    </svg>
  );
}

export const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", Icon: DashboardIcon },
  { href: "/portfolios", label: "Portfolios", Icon: PortfoliosIcon },
  { href: "/expenses", label: "Expenses", Icon: ExpensesIcon },
] as const;
