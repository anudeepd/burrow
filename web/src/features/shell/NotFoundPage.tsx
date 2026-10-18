import { CenteredPageState, EmptyState } from "~/ui/feedback";

export function NotFoundPage() {
  return (
    <CenteredPageState>
      <EmptyState
        title="No such page"
        action={
          <a className="text-live underline" href="/">
            Back to the overview
          </a>
        }
      >
        That route does not exist in this build.
      </EmptyState>
    </CenteredPageState>
  );
}
