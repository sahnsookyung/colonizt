import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const publicTargets = ["README.md", "docs", "packages/web/src"];
const forbidden = [/colonist\.io/i, /catan[^-like]/i];
const allowedContext = [/job-preparation/i, /IP context/i, /does not copy/i, /exact CATAN rules parity/i];
const violations: string[] = [];

const walk = (path: string): string[] => {
  const full = join(root, path);
  const stat = statSync(full);
  if (stat.isFile()) return [path];
  return readdirSync(full).flatMap((entry) => walk(join(path, entry)));
};

for (const target of publicTargets) {
  try {
    for (const file of walk(target)) {
      const text = readFileSync(join(root, file), "utf8");
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        if (forbidden.some((pattern) => pattern.test(line)) && !allowedContext.some((pattern) => pattern.test(line))) {
          violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  } catch {
    // Some targets are created later.
  }
}

if (violations.length > 0) {
  throw new Error(`Forbidden branding references found:\n${violations.join("\n")}`);
}

console.log("Branding scan passed");
