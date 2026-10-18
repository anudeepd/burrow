// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The motion contract (DESIGN §5). These are the rules a future edit is most likely to break silently — a stray
 * `ease-in`, a loop without its reduced-motion escape, a Tailwind transition with no duration token that the
 * `data-motion` gate therefore cannot see (it only zeroes custom properties). They are cheap to check over the source,
 * so the system cannot rot back into one-off tweens.
 */
const read = (path: string) => readFileSync(path, "utf8");
const CSS_FILES = ["src/styles/app.css", "src/features/dag/dag.css"];
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
/** Motion is only allowed to touch these properties (the SVG dash exception is documented in DESIGN §5.5). */
const ANIMATABLE = /^\s*(transform|opacity|stroke-dashoffset)\s*:/;
const MOTION_GUARD = /data-motion="reduced"/;
const PARITY_GUARD = /data-parity/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

describe("CSS motion contract", () => {
  for (const file of CSS_FILES) {
    describe(file, () => {
      const css = stripComments(read(file));

      it("never uses transition: all", () => {
        expect(css).not.toMatch(/transition:\s*all/);
      });

      it("never uses ease-in (ease-in-out is fine)", () => {
        expect(css).not.toMatch(/[^-]ease-in(?![-\w])/);
      });

      it("never animates from scale(0)", () => {
        expect(css).not.toMatch(/scale\(0\)/);
      });

      it("gates every infinite animation on the motion predicate and the parity predicate", () => {
        // split into "selector { body }" chunks; @keyframes bodies are skipped by their own marker
        const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
        const offenders = blocks
          .filter((b) => /\banimation[^;]*infinite/.test(b.body))
          .filter((b) => !(MOTION_GUARD.test(b.selector) && PARITY_GUARD.test(b.selector)))
          .map((b) => b.selector);
        expect(offenders).toEqual([]);
      });

      it("pairs every loop with a prefers-reduced-motion escape", () => {
        const loops = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]!);
        expect(loops.length).toBeGreaterThan(0);
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
        // every animation-name that loops must be spelled out by a keyframes block in the same file
        const used = [...css.matchAll(/animation(?:-name)?:\s*([\w-]+)/g)].map((m) => m[1]!).filter((n) => n !== "none");
        for (const name of used) expect(loops, `${name} has no @keyframes`).toContain(name);
      });

      it("only animates transform, opacity or stroke-dashoffset", () => {
        const bodies: string[] = [];
        const marker = /@keyframes\s+[\w-]+\s*\{/g;
        for (const match of css.matchAll(marker)) {
          let depth = 1;
          let i = match.index + match[0].length;
          while (i < css.length && depth > 0) {
            if (css[i] === "{") depth += 1;
            else if (css[i] === "}") depth -= 1;
            i += 1;
          }
          bodies.push(css.slice(match.index + match[0].length, i - 1));
        }
        expect(bodies.length).toBeGreaterThan(0);
        for (const body of bodies) {
          for (const decl of body.matchAll(/([a-z-]+)\s*:/g)) {
            const property = decl[1]!;
            expect(ANIMATABLE.test(`${property}:`), `keyframes may not animate \`${property}\``).toBe(true);
          }
        }
      });
    });
  }

  it("keeps running DAG nodes visibly hatched under reduced motion", () => {
    const dag = stripComments(read("src/features/dag/dag.css"));
    expect(dag).toMatch(
      /html\[data-motion="reduced"\] \.burrow-dag-node\[data-running="true"\] \.burrow-dag-node-hatch,[\s\S]*?\{\s*opacity:\s*1;/,
    );
    expect(dag).toMatch(
      /html:not\(\[data-motion="reduced"\]\):not\(\[data-parity\]\)[^{]*\.burrow-dag-node\[data-running="true"\]\s+\.burrow-dag-node-shimmer\s*\{[^}]*animation:\s*burrow-dag-shimmer/,
    );
  });
});

describe("token contract", () => {
  const tokens = read("src/styles/tokens.css");

  it("keeps opacity fades under reduced motion, but not under parity", () => {
    const reduced = /html\[data-motion="reduced"\]\s*\{([\s\S]*?)\}/.exec(read("src/styles/app.css"))?.[1] ?? "";
    const parity = /html\[data-parity\]\s*\{([\s\S]*?)\}/.exec(read("src/styles/app.css"))?.[1] ?? "";
    expect(reduced).not.toMatch(/--dur-fade:\s*0ms/);
    expect(reduced).toMatch(/--dur-content:\s*var\(--dur-fade\)/);
    expect(parity).toMatch(/--dur-fade:\s*0ms/);
    expect(parity).toMatch(/--dur-content:\s*0ms/);
    expect(reduced).toMatch(/--dur-base:\s*0ms/);
    expect(parity).toMatch(/--dur-base:\s*0ms/);
  });

  it("defines every duration a component may name", () => {
    for (const token of ["--dur-instant", "--dur-fade", "--dur-content", "--dur-fast", "--dur-base", "--dur-slow", "--dur-sheet", "--dur-tween", "--dur-flash"]) {
      expect(tokens, token).toContain(token);
    }
  });
});

describe("Tailwind transition contract", () => {
  it("gives every transition utility an explicit duration token (or an inline override)", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      if (file.includes("__tests__") || file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const source = read(file);
      for (const line of source.split("\n")) {
        // a Tailwind transition/rotate utility with no `duration-(--dur-*)` on the same line is invisible to the
        // `html[data-motion="reduced"]` gate, which only zeroes the `--dur-*` custom properties
        if (!/transition[-\[]|animate-\w/.test(line)) continue;
        if (/duration-\(--dur|duration-\[|\[transition-duration:/.test(line)) continue;
        if (/^\s*[/*]|animate-(spin|pulse)/.test(line.trim())) continue; // comments; spinners are Tier-3 and slowed in CSS
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
