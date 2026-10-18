/**
 * Raw SQL plan tree — Spark's `planDescription` (the newline-indented ASCII tree its SQL tab prints) as a foldable,
 * searchable `<pre>`.
 *
 * Folding is depth-based: each line's tree column is the index where its node name starts (the `+- ` marker belongs to
 * the parent's column), so collapsing a line hides every line nested under it without re-parsing Spark's grammar.
 * Search (URL `?q=`) highlights matches and can filter to matches while keeping their ancestors for context.
 *
 * `data-yf="spark.sql.planDescription"` carries the *whole* plan string on the `<pre>`, so parity always sees the raw
 * value; in parity mode folding is disabled so the visible tree is complete.
 */
import { Check, ChevronDown, Copy, Search } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { cn } from "~/lib/cn";
import { copyText } from "~/lib/copy";
import { useParity } from "~/state/parity";
import { Button } from "~/ui/button";
import { Datum } from "~/ui/datum";
import { Switch } from "~/ui/toggles";
import { Tooltip } from "~/ui/tooltip";

interface PlanLine {
  /** 0-based line index in the original text. */
  i: number;
  text: string;
  /** tree column: node-name start offset / 3. */
  col: number;
  parent: number | null;
  children: number[];
}

/** Node column of a plan line. `+- ` occupies the parent's column, so the node starts 3 chars after the marker. */
function columnOf(line: string): number {
  const marker = line.indexOf("+- ");
  if (marker >= 0) return (marker + 3) / 3;
  const lead = line.length - line.trimStart().length;
  return Math.floor(lead / 3);
}

function buildTree(plan: string): PlanLine[] {
  const raw = plan.split("\n");
  const lines: PlanLine[] = raw.map((text, i) => ({ i, text, col: columnOf(text), parent: null, children: [] }));
  const stack: number[] = [];
  for (const line of lines) {
    while (stack.length && (lines[stack[stack.length - 1] as number] as PlanLine).col >= line.col) stack.pop();
    const parent = stack.length ? (stack[stack.length - 1] as number) : null;
    line.parent = parent;
    if (parent != null) (lines[parent] as PlanLine).children.push(line.i);
    stack.push(line.i);
  }
  return lines;
}

/** Split `text` into highlighted / plain segments for a case-insensitive query. */
function highlight(text: string, q: string, key: number): ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: ReactNode[] = [];
  let at = 0;
  let found = lower.indexOf(needle, at);
  let n = 0;
  while (found >= 0) {
    if (found > at) out.push(text.slice(at, found));
    out.push(
      <mark key={`${key}-${n++}`} className="rounded-xs bg-warn/30 text-ink">
        {text.slice(found, found + needle.length)}
      </mark>,
    );
    at = found + needle.length;
    found = lower.indexOf(needle, at);
  }
  if (at < text.length) out.push(text.slice(at));
  return out.length ? out : text;
}

export function PlanTree({
  plan,
  q,
  onQ,
  className,
}: {
  plan: string | null | undefined;
  q: string;
  onQ: (v: string) => void;
  className?: string;
}) {
  const parity = useParity();
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set<number>());
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [copied, setCopied] = useState(false);

  const lines = useMemo(() => (plan ? buildTree(plan) : []), [plan]);
  const needle = q.trim().toLowerCase();

  const matches = useMemo(() => lines.map((l) => (needle ? l.text.toLowerCase().includes(needle) : false)), [lines, needle]);
  const matchCount = useMemo(() => matches.reduce((n, m) => n + (m ? 1 : 0), 0), [matches]);

  /** With "only matches", keep a line when it matches or any descendant does (parents give context). */
  const keep = useMemo(() => {
    if (!needle || !onlyMatches) return null;
    const reach = matches.slice();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (reach[i]) continue;
      for (const c of (lines[i] as PlanLine).children) if (reach[c]) reach[i] = true;
    }
    return reach;
  }, [lines, matches, needle, onlyMatches]);

  const ancestors = useMemo(() => {
    const out: number[][] = [];
    for (const l of lines) {
      const chain: number[] = [];
      let p = l.parent;
      while (p != null) {
        chain.push(p);
        p = (lines[p] as PlanLine).parent;
      }
      out.push(chain);
    }
    return out;
  }, [lines]);

  const hidden = useMemo(() => {
    if (parity) return new Set<number>();
    const set = new Set<number>();
    for (const l of lines) for (const a of ancestors[l.i] as number[]) if (collapsed.has(a)) set.add(l.i);
    return set;
  }, [lines, ancestors, collapsed, parity]);

  const toggle = (i: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const copy = async () => {
    try {
      const didCopy = await copyText(plan ?? "");
      setCopied(didCopy);
      if (didCopy) window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  if (!plan) {
    return (
      <p className={cn("rounded-md border border-dashed border-seam-strong bg-well px-2.5 py-2 text-small text-ink-3", className)}>
        Spark's REST SQL payload carries no <code className="font-mono text-micro">planDescription</code> for this execution.
      </p>
    );
  }

  const nodeCount = lines.filter((l) => l.children.length > 0).length;

  return (
    <div className={cn("min-w-0 overflow-hidden rounded-lg border border-seam bg-fabric", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-seam p-3">
        <label className="flex items-center gap-1.5 text-small text-ink-3">
          <span className="sr-only">Find in the SQL plan</span>
          <Search className="size-3.5 text-ink-4" aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => onQ(e.target.value)}
            placeholder="Find in plan…"
            className="h-(--ctl-h) w-56 rounded-md border border-seam-strong bg-well px-2 text-body text-ink placeholder:text-ink-4"
          />
        </label>
        <span className="text-small text-ink-4">
          {needle ? (
            <>
              <span className="tnum">{matchCount}</span> matching lines
            </>
          ) : (
            <>
              <span className="tnum">{lines.length}</span> lines · <span className="tnum">{nodeCount}</span> with children
            </>
          )}
        </span>
        <span className="flex items-center gap-1.5 text-small text-ink-3">
          <Switch checked={onlyMatches} onCheckedChange={setOnlyMatches} label="Show only matching lines and their parents" />
          Only matches
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button variant="quiet" size="sm" onClick={() => setCollapsed(new Set<number>())}>
            Expand all
          </Button>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => setCollapsed(new Set(lines.filter((l) => l.children.length > 0).map((l) => l.i)))}
          >
            Collapse all
          </Button>
          <Button variant="default" size="sm" onClick={() => void copy()}>
            {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </span>
      </div>
      <Datum
        field="spark.sql.planDescription"
        raw={plan}
        as="pre"
        className="max-h-[32rem] min-h-24 w-full overflow-auto bg-well p-3 font-mono text-micro leading-[1.55] text-ink-2"
      >
        {lines.map((l) => {
          if (hidden.has(l.i)) return null;
          if (keep && !keep[l.i]) return null;
          const isCollapsed = collapsed.has(l.i);
          return (
            <span key={l.i} className="block min-h-11 whitespace-pre sm:min-h-0">
              {l.children.length > 0 && !parity ? (
                <Tooltip label={`${isCollapsed ? "Expand" : "Collapse"} plan lines under line ${l.i + 1}`}>
                  <button
                    type="button"
                    onClick={() => toggle(l.i)}
                    aria-expanded={!isCollapsed}
                    aria-label={`${isCollapsed ? "Expand" : "Collapse"} plan lines under line ${l.i + 1}`}
                    className="burrow-touch-target mr-1 inline-flex size-11 cursor-pointer items-center justify-center align-middle text-ink-4 hover:text-ink sm:size-3"
                  >
                    {/* one glyph that rotates rather than a swap between two mounts */}
                    <ChevronDown
                      className={cn("size-3 transition-transform duration-(--dur-fast) ease-(--ease-out)", isCollapsed && "-rotate-90")}
                      aria-hidden="true"
                    />
                  </button>
                </Tooltip>
              ) : (
                <span className="burrow-touch-target mr-1 inline-flex size-11 align-middle sm:size-3" aria-hidden="true" />
              )}
              {highlight(l.text, needle, l.i)}
            </span>
          );
        })}
      </Datum>
    </div>
  );
}
