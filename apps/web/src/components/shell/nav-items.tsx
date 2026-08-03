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

function IncomeIcon({ className }: IconProps) {
  return (
    <svg {...stroke} className={className} aria-hidden>
      <path d="M12 3.5v9.5" />
      <path d="M8.5 9.5L12 13l3.5-3.5" />
      <path d="M4 15v3.5a1.5 1.5 0 001.5 1.5h13a1.5 1.5 0 001.5-1.5V15" />
    </svg>
  );
}

function TransfersIcon({ className }: IconProps) {
  return (
    <svg {...stroke} className={className} aria-hidden>
      <path d="M4 9h13" />
      <path d="M14 6l3 3-3 3" />
      <path d="M20 15H7" />
      <path d="M10 12l-3 3 3 3" />
    </svg>
  );
}

function DebtsIcon({ className }: IconProps) {
  return (
    <svg {...stroke} className={className} aria-hidden>
      <path d="M12 4.5v15" />
      <path d="M4.5 8.5h9a2.75 2.75 0 010 5.5h-3a2.75 2.75 0 000 5.5h9" />
    </svg>
  );
}

function GoalsIcon({ className }: IconProps) {
  return (
    <svg {...stroke} className={className} aria-hidden>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.25" />
    </svg>
  );
}

function InvestmentsIcon({ className }: IconProps) {
  return (
    <svg {...stroke} className={className} aria-hidden>
      <path d="M4 19V9M10 19V5M16 19v-6M20.5 19V11" />
      <path d="M3 19h18" />
    </svg>
  );
}

// Ordered by how money actually moves: where it sits, in, out, between, owed,
// then what it is being saved toward. Investments sit after Goals rather than
// beside Portfolios on purpose — they are not spendable cash (Rule 17), and
// putting them next to accounts would suggest the two totals add up.
export const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", Icon: DashboardIcon },
  { href: "/portfolios", label: "Portfolios", Icon: PortfoliosIcon },
  { href: "/income", label: "Income", Icon: IncomeIcon },
  { href: "/expenses", label: "Expenses", Icon: ExpensesIcon },
  { href: "/transfers", label: "Transfers", Icon: TransfersIcon },
  { href: "/debts", label: "Debts", Icon: DebtsIcon },
  { href: "/goals", label: "Goals", Icon: GoalsIcon },
  { href: "/investments", label: "Investments", Icon: InvestmentsIcon },
] as const;
