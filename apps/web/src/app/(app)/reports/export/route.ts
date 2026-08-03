import { createClient } from "@/lib/supabase/server";
import { dbError, startTimer } from "@/lib/logger";
import { requestLogger } from "@/lib/request-context";
import { parseQuery } from "../range";
import { TXN_SELECT, isCounted, rowLabel } from "../rows";
import { one, type TransactionRow } from "../types";

/**
 * CSV export of the in-range transaction list.
 *
 * It lives at `/reports/export` rather than `/reports` because a `route.ts`
 * cannot sit at the same segment level as a `page.tsx` (Next 16 route handler
 * convention). Route handlers are uncached by default, which is what we want —
 * this reflects live data and is scoped to the caller's session.
 *
 * The export is the transaction LIST, not the summaries (Phase 5 decision D4):
 * exporting six numbers you can already read on screen is not what anyone opens
 * a spreadsheet for.
 */

/**
 * Deliberately higher than the screen's 500. On screen a cap is a readability
 * choice; in an export it is data loss, so the ceiling exists only to keep the
 * response inside Vercel Hobby's ~10s function budget. If it is ever hit, the
 * file says so in a final row AND in a response header — a silently truncated
 * export is a corrupted record, and the person who opens it in a spreadsheet a
 * month later has no way to know.
 */
const EXPORT_ROW_LIMIT = 5000;

/**
 * One CSV field, RFC 4180 style: always quoted, interior quotes doubled.
 *
 * Quoting unconditionally rather than only when needed is the point. A merchant
 * called `Bag, The`, a note containing a newline, or a description with a quote
 * in it all break a naive `join(",")` — and each produces a file that opens
 * without error and is silently wrong by one column.
 */
function csvField(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(fields: (string | number | null | undefined)[]): string {
  return fields.map(csvField).join(",");
}

export async function GET(request: Request) {
  const log = await requestLogger({ route: "/reports/export" });
  const elapsed = startTimer();

  const url = new URL(request.url);
  const query = parseQuery({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    currency: url.searchParams.get("currency") ?? undefined,
    preset: url.searchParams.get("preset") ?? undefined,
  });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    log.warn("reports.export.unauthenticated");
    // A file download cannot usefully redirect to a login form, so this is a
    // plain 401 rather than the redirect the pages use.
    return new Response("Not authenticated", { status: 401 });
  }

  const routeLog = log.child({ userId: user.id });

  // The currency is required here, unlike on the page, which can fall back to
  // the profile default. An export whose currency was guessed is worse than one
  // that refuses: the file outlives the request that produced it.
  const code = query.currency;
  if (!code) {
    routeLog.warn("reports.export.no_currency", { from: query.from, to: query.to });
    return new Response("A currency is required.", { status: 400 });
  }

  const { data, error } = await supabase
    .from("transactions")
    .select(TXN_SELECT)
    .eq("is_void", false)
    .eq("currency.code", code)
    .gte("txn_date", query.from)
    .lte("txn_date", query.to)
    .order("txn_date", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(EXPORT_ROW_LIMIT);

  if (error) {
    routeLog.error("reports.export.load_failed", {
      from: query.from,
      to: query.to,
      currency: code,
      ...dbError(error),
    });
    return new Response("Could not build the export.", { status: 500 });
  }

  const rows = (data ?? []) as unknown as TransactionRow[];
  const truncated = rows.length >= EXPORT_ROW_LIMIT;

  const lines = [
    csvRow([
      "Date",
      "Type",
      "Category or source",
      "Description",
      "Account",
      "Direction",
      "Amount",
      "Currency",
      "Counted in totals",
    ]),
    ...rows.map((t) =>
      csvRow([
        // Already YYYY-MM-DD from a Postgres `date`. Never localised: a
        // spreadsheet guesses at anything else, and guesses differently by
        // locale, which is how 03/04 becomes March in one place and April in
        // another.
        t.txn_date,
        t.kind,
        rowLabel(t),
        t.description,
        one(t.portfolio)?.name ?? "",
        t.direction,
        // Raw, unformatted, no thousands separators or symbol — this column is
        // for arithmetic. The currency is its own column, and the file holds
        // exactly one (decision D3).
        String(t.amount),
        one(t.currency)?.code ?? code,
        isCounted(t) ? "yes" : "no",
      ]),
    ),
  ];

  if (truncated) {
    lines.push(
      csvRow([
        `TRUNCATED: only the first ${EXPORT_ROW_LIMIT} transactions are included. Narrow the date range and export again.`,
      ]),
    );
  }

  routeLog.info("reports.export.ok", {
    from: query.from,
    to: query.to,
    currency: code,
    rows: rows.length,
    truncated,
    durationMs: elapsed(),
  });

  const filename = `ledgerly-${code}-${query.from}-to-${query.to}.csv`;

  return new Response(lines.join("\r\n"), {
    status: 200,
    headers: {
      // charset matters: symbols like ₱ are multi-byte, and a spreadsheet that
      // assumes latin-1 renders them as mojibake.
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      // Machine-readable twin of the final row, so a script consuming this
      // doesn't have to parse prose to learn the file is incomplete.
      "x-ledgerly-truncated": truncated ? "true" : "false",
    },
  });
}
