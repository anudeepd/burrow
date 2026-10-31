import { highlightJmxText } from "./jmx";

/** Consistent search highlighting for the JMX tree and thread-dump viewer. */
export function HighlightedText({ text, query }: { text: string; query: string }) {
  const parts = highlightJmxText(text, query);
  return (
    <>
      {parts.map((part, i) =>
        part.hit ? (
          <mark key={i} className="rounded-xs bg-live/25 px-0.5 text-ink">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
