// Debt enums, mirrored from db public.debt_kind / public.debt_status, plus the
// small display helpers both debt pages need.

export const DEBT_KINDS = [
  {
    value: "payable",
    label: "I owe this",
    heading: "You owe",
    // Which way the cash moves when the debt is created, and what a payment
    // against it is called. Both pages read these rather than branching on the
    // kind in five different places.
    disbursementLabel: "Cash landed in",
    disbursementHint: "The account the borrowed money went into.",
    paymentTitle: "Record a payment",
    paymentVerb: "Pay",
    accountLabel: "Pay from",
  },
  {
    value: "receivable",
    label: "I'm owed this",
    heading: "Owed to you",
    disbursementLabel: "Cash came out of",
    disbursementHint: "The account you lent the money from.",
    paymentTitle: "Record a collection",
    paymentVerb: "Collect",
    accountLabel: "Collect into",
  },
] as const;

export type DebtKind = (typeof DEBT_KINDS)[number]["value"];

export const DEBT_KIND_VALUES: string[] = DEBT_KINDS.map((k) => k.value);

export function debtKind(value: string) {
  return DEBT_KINDS.find((k) => k.value === value) ?? DEBT_KINDS[0];
}

/**
 * Reasons a debt's balance can change without any cash moving, mirrored from
 * db public.debt_adjustment_reason.
 *
 * `grows` is not decoration — the DB pins the sign to the reason (a check
 * constraint plus a guard in create_debt_adjustment), so the form has to know
 * which way each one points and send the amount signed accordingly. 'correction'
 * is the only one that takes either sign, which is why it carries null.
 */
export const ADJUSTMENT_REASONS = [
  {
    value: "interest",
    label: "Interest accrued",
    grows: true,
    hint: "Interest added to what's owed. Nothing accrues on its own — record it when a statement arrives.",
  },
  {
    value: "fee",
    label: "Fee or penalty",
    grows: true,
    hint: "A charge added to the debt.",
  },
  {
    value: "payment_off_app",
    label: "Paid outside this app",
    grows: false,
    hint: "Money really changed hands, but not through an account tracked here — so no balance moves.",
  },
  {
    value: "forgiven",
    label: "Written down / forgiven",
    grows: false,
    hint: "Part of the debt was cancelled by agreement. No money changed hands.",
  },
  {
    value: "correction",
    label: "Correction",
    grows: null,
    hint: "The figure was simply wrong. Use + to increase what's owed, − to reduce it.",
  },
] as const;

export const ADJUSTMENT_REASON_VALUES: string[] = ADJUSTMENT_REASONS.map(
  (r) => r.value,
);

export function adjustmentReason(value: string) {
  return ADJUSTMENT_REASONS.find((r) => r.value === value) ?? ADJUSTMENT_REASONS[0];
}

export function adjustmentReasonLabel(value: string): string {
  return ADJUSTMENT_REASONS.find((r) => r.value === value)?.label ?? value;
}

export const DEBT_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  partially_paid: "Partly paid",
  settled: "Settled",
  written_off: "Written off",
};

export function debtStatusLabel(value: string): string {
  return DEBT_STATUS_LABELS[value] ?? value;
}

/**
 * Whether a debt still represents money anyone expects to move. `written_off`
 * can carry a non-zero outstanding balance — you gave up on it, you did not
 * collect it — so it must stay out of the "total owed" figures alongside
 * `settled`.
 */
export function isLiveDebt(status: string): boolean {
  return status !== "settled" && status !== "written_off";
}

/** Today as `YYYY-MM-DD` in local time — the format every date input wants. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Overdue is computed, never stored: `debt_status` has no 'overdue' value and
 * adding one would mean a scheduled job to keep it true. A settled or
 * written-off debt is never overdue no matter how old the due date is.
 */
export function isOverdue(
  dueDate: string | null,
  status: string,
  today = todayIso(),
): boolean {
  if (!dueDate || !isLiveDebt(status)) return false;
  // Both sides are YYYY-MM-DD, so a string compare is a date compare.
  return dueDate < today;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** PostgREST returns an embedded one-to-one as either an object or a 1-element array. */
export function one<T>(v: T | T[] | null | undefined): T | undefined {
  return (Array.isArray(v) ? v[0] : v) ?? undefined;
}
