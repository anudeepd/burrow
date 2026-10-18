type BurrowBrandProps = {
  tone: "dark" | "light";
  wordmark?: boolean;
  className?: string;
};

const palettes = {
  dark: { line: "#4CD7D7", first: "#82A7FF", second: "#4CD7D7", third: "#F4C95D", word: "#F4F8FB" },
  light: { line: "#007D80", first: "#365FB5", second: "#007D80", third: "#8A5B00", word: "#111820" },
} as const;

/** Inline Burrow artwork so the shell doesn't expose a standalone logo-image URL. */
export function BurrowBrand({ tone, wordmark = false, className }: BurrowBrandProps) {
  const colors = palettes[tone];
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      viewBox={wordmark ? "0 0 136 40" : "0 0 40 40"}
      width={wordmark ? 136 : 40}
      height={40}
      fill="none"
    >
      <path d="M6.5 33V20a13.5 13.5 0 0 1 27 0v13" stroke={colors.line} strokeWidth="2.6" strokeLinecap="round" />
      <path d="M23.7 16 14.7 22 23.7 28" stroke={colors.line} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="23.7" cy="16" r="2.15" fill={colors.first} />
      <circle cx="14.7" cy="22" r="2.15" fill={colors.second} />
      <circle cx="23.7" cy="28" r="2.15" fill={colors.third} />
      {wordmark && (
        <text
          x="47"
          y="29"
          fill={colors.word}
          fontFamily="'IBM Plex Sans Variable', 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif"
          fontSize="25"
          fontWeight="600"
          letterSpacing="-0.7"
        >
          burrow
        </text>
      )}
    </svg>
  );
}
