#!/usr/bin/env node
/* global console */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const workflowsDirectory = ".github/workflows";
const violations = [];

const workflowFiles = readdirSync(workflowsDirectory)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort((left, right) => left.localeCompare(right));

for (const file of workflowFiles) {
  const path = join(workflowsDirectory, file);
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trimStart();
    const entry = trimmed.startsWith("-") ? trimmed.slice(1).trimStart() : trimmed;
    if (!entry.startsWith("uses:")) return;
    const reference = entry.slice("uses:".length).trim();
    if (reference.startsWith("./") || reference.startsWith("docker://")) return;
    const commentStart = reference.indexOf(" #");
    const action = (commentStart >= 0 ? reference.slice(0, commentStart) : reference).trimEnd();
    const revisionStart = action.lastIndexOf("@");
    const revision = revisionStart >= 0 ? action.slice(revisionStart + 1) : "";
    if (revisionStart <= 0 || !/^[0-9a-f]{40}$/u.test(revision)) {
      violations.push(`${path}:${index + 1} uses mutable action reference ${reference}`);
    }
  });
}

if (violations.length > 0) {
  throw new Error(`GitHub Actions must be pinned to immutable 40-character commits:\n${violations.join("\n")}`);
}

console.log("Validated immutable GitHub Action references.");
