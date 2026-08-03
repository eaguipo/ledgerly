/**
 * What a delete Server Action hands back to its form.
 *
 * A delete that works redirects, and `redirect()` throws — so the only state
 * that ever reaches the form is a refusal. Those are real and worth showing
 * rather than swallowing: deleting income the account has already spent is
 * rejected by the overdraft pre-check in `delete_income()`, and an expense that
 * turns out to be a debt or investment leg is rejected outright. A plain
 * fire-and-forget `<form action={…}>` — the shape archive/restore use — would
 * leave the row on screen with no explanation of why.
 */
export type DeleteState =
  | { status: "idle" }
  | { status: "error"; message: string };

export const idleDelete: DeleteState = { status: "idle" };
