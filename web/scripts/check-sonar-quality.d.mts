export type SonarMetricValue = number | string | null | undefined;

export function evaluateSonarMetrics(measures: Record<string, SonarMetricValue>): string[];

export function fetchSonarMetrics(options: {
  host: string;
  project: string;
  token?: string;
  fetcher?: typeof fetch;
}): Promise<Record<string, string>>;

export function main(): Promise<void>;
