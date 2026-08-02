"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";
import { PageContainer, PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { clientError, clientErrorFields } from "@/lib/client-logger";

/**
 * Error boundary for every signed-in route. Without it, a render failure in a
 * page shows Next's default screen and nothing is recorded on the client side.
 *
 * `digest` is the link between the two halves of the story: the server already
 * logged the full stack under this digest (see instrumentation.ts →
 * `web.request.error`), while production deliberately withholds the message
 * from the browser. Showing it here means a user can quote it back and it can be
 * grepped straight out of the logs.
 */
export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    clientError("web.boundary.app_error", clientErrorFields(error));
  }, [error]);

  return (
    <PageContainer>
      <PageHeader title="Something went wrong" />
      <EmptyState
        title="This page couldn't be loaded"
        description={
          <>
            The error has been logged. Trying again often works — the usual
            cause is a service that was briefly unreachable.
            {error.digest ? (
              <>
                {" "}
                Reference: <span className="figure">{error.digest}</span>
              </>
            ) : null}
          </>
        }
        action={
          <Button variant="primary" onClick={() => unstable_retry()}>
            Try again
          </Button>
        }
      />
    </PageContainer>
  );
}
