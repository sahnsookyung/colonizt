/* global console */
import { readFileSync } from "node:fs";

const docs = ["docs/architecture.md"];
const allowedHeaders = ["flowchart", "sequenceDiagram", "erDiagram"];

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
  });
  console.log(`Validated ${blocks.length} Mermaid block(s) in ${path}`);
}
