#!/usr/bin/env node
/* global console */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const workflowsDirectory = ".github/workflows";
const immutableAction = /^[^\s@]+@[0-9a-f]{40}(?:\s+#\s+.+)?$/u;
const violations = [];

for (const file of readdirSync(workflowsDirectory).filter((name) => /\.ya?ml$/u.test(name)).sort()) {
  const path = join(workflowsDirectory, file);
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    const match = line.match(/^\s*-?\s*uses:\s*(.+?)\s*$/u);
    if (!match) return;
    const reference = match[1];
    if (reference.startsWith("./") || reference.startsWith("docker://")) return;
    if (!immutableAction.test(reference)) {
      violations.push(`${path}:${index + 1} uses mutable action reference ${reference}`);
    }
  });
}

if (violations.length > 0) {
  throw new Error(`GitHub Actions must be pinned to immutable 40-character commits:\n${violations.join("\n")}`);
}

console.log("Validated immutable GitHub Action references.");
