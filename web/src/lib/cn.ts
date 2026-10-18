import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The type scale lives in `styles/tokens.css` (`--text-micro` … `--text-display`), so tailwind-merge cannot know
 * those names are font sizes: it buckets every unrecognised `text-*` into the text-colour group, and a later
 * `text-small` silently evicts an earlier `text-on-live`. Registering the scale keeps sizes and colours apart.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "caption", "small", "body", "cell", "lead", "h3", "h2", "h1", "metric", "display"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
