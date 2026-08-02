import { PageContainer } from "@/components/shell/page-header";
import { Card, CardBody } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/feedback";

/**
 * Shared skeleton for every route in the shell. The shell itself (sidebar, tab
 * bar) is in the layout and stays put, so only the content region swaps —
 * navigation never blanks out.
 */
export default function AppLoading() {
  return (
    <PageContainer>
      <div className="mb-7">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody>
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-3 h-11 w-64" />
            <Skeleton className="mt-3 h-3.5 w-48" />
            <Skeleton className="mt-6 h-28 w-full" />
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i}>
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="mt-2 h-2 w-full" />
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
