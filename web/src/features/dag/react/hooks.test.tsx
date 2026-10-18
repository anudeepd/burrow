/**
 * `useRafValue` feeds the DAG pane its render value, so a hook that stops settling freezes the whole graph: it opens at
 * 1:1 from the world origin and pan, zoom and "fit" all change state without moving anything on screen.
 *
 * The failure only shows up when the hook's effects remount — React StrictMode's mount/unmount/mount, or a Suspense
 * retry — because that cancels the scheduled frame without running its callback. Production has no StrictMode and the
 * Playwright DAG snapshots run against the built app, so this test is the only place the wedge is observable.
 */
import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRafValue } from "./hooks";

afterEach(cleanup);

/** One animation frame, plus the commit it schedules. */
function frame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => {
    setTimeout(resolve, 0);
  });
  return promise;
}

function Probe({ value }: { value: number }) {
  const settled = useRafValue(value);
  return <span data-testid="settled">{settled}</span>;
}

describe("useRafValue", () => {
  it("keeps settling new values after a StrictMode effect remount", async () => {
    const { getByTestId, rerender } = render(
      <StrictMode>
        <Probe value={1} />
      </StrictMode>,
    );
    await act(frame);
    expect(getByTestId("settled").textContent).toBe("1");

    rerender(
      <StrictMode>
        <Probe value={2} />
      </StrictMode>,
    );
    await act(frame);
    expect(getByTestId("settled").textContent).toBe("2");

    rerender(
      <StrictMode>
        <Probe value={3} />
      </StrictMode>,
    );
    await act(frame);
    expect(getByTestId("settled").textContent).toBe("3");
  });

  it("settles without StrictMode too", async () => {
    const { getByTestId, rerender } = render(<Probe value={1} />);
    await act(frame);
    expect(getByTestId("settled").textContent).toBe("1");

    rerender(<Probe value={2} />);
    await act(frame);
    expect(getByTestId("settled").textContent).toBe("2");
  });
});
