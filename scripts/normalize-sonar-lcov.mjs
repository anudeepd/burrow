import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repoRoot, "web");
const reportPath = path.join(webRoot, "coverage", "lcov.info");

if (!existsSync(reportPath)) {
  throw new Error(`Vitest coverage report not found: ${reportPath}`);
}

const report = readFileSync(reportPath, "utf8").replace(/^SF:(.*)$/gm, (_line, sourcePath) => {
  const absolutePath = path.isAbsolute(sourcePath)
    ? path.normalize(sourcePath)
    : path.resolve(sourcePath.startsWith("web/") ? repoRoot : webRoot, sourcePath);
  const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");

  if (relativePath.startsWith("../") || relativePath === ".." || !existsSync(absolutePath)) {
    throw new Error(`LCOV source does not resolve to a repository file: ${sourcePath}`);
  }

  return `SF:${relativePath}`;
});

writeFileSync(reportPath, report);
