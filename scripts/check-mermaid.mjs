/* global console */
import { readFileSync } from "node:fs";

const docs = ["docs/architecture.md", "README.md"];
const allowedHeaders = ["flowchart", "sequenceDiagram", "erDiagram"];
const maxReadableLines = 80;
const maxReadableLineChars = 118;
const maxReadableLabelChars = 72;

const assertBalanced = (block, path, blockIndex, firstLine) => {
  const stack = [];
  let quote;
  let escaped = false;
  const pairs = firstLine === "erDiagram" ? { "(": ")", "[": "]" } : { "(": ")", "[": "]", "{": "}" };
  const closers = new Set(Object.values(pairs));
  for (const char of block) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (pairs[char]) stack.push(pairs[char]);
    else if (closers.has(char) && stack.pop() !== char) {
      throw new Error(`${path} mermaid block ${blockIndex} has unbalanced ${char}`);
    }
  }
  if (quote) throw new Error(`${path} mermaid block ${blockIndex} has an unterminated quote`);
  if (stack.length > 0) throw new Error(`${path} mermaid block ${blockIndex} has unbalanced brackets`);
};

const normalizedLabel = (label) =>
  label.replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();

const assertReadable = (block, path, blockIndex) => {
  const lines = block.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length > maxReadableLines) {
    throw new Error(`${path} mermaid block ${blockIndex} has ${lines.length} lines; split dense diagrams before they become unreadable`);
  }
  lines.forEach((line, lineIndex) => {
    if (line.length > maxReadableLineChars) {
      throw new Error(`${path} mermaid block ${blockIndex} line ${lineIndex + 1} is too long for readable rendering`);
    }
  });

  for (const match of block.matchAll(/"([^"]+)"/g)) {
    const label = normalizedLabel(match[1] ?? "");
    if (label.length > maxReadableLabelChars) {
      throw new Error(`${path} mermaid block ${blockIndex} label "${label}" is too long; move detail into prose`);
    }
  }
};

for (const path of docs) {
  const content = readFileSync(path, "utf8");
  const blocks = [...content.matchAll(/```mermaid\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? "");
  if (blocks.length === 0) throw new Error(`${path} does not contain Mermaid diagrams`);
  blocks.forEach((block, index) => {
    const firstLine = block.trimStart().split(/\r?\n/)[0]?.trim() ?? "";
    if (!allowedHeaders.some((header) => firstLine === header || firstLine.startsWith(`${header} `))) {
      throw new Error(`${path} mermaid block ${index + 1} starts with unsupported header "${firstLine}"`);
    }
    assertBalanced(block, path, index + 1, firstLine);
    assertReadable(block, path, index + 1);
  });
  console.log(`Validated ${blocks.length} Mermaid block(s) in ${path}`);
}
