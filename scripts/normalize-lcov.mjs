#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { log } from "node:console";
import { argv } from "node:process";

const [path = "coverage/lcov.info"] = argv.slice(2);
const source = readFileSync(path, "utf8");
const branchRecordPrefixes = ["BRDA:", "BRF:", "BRH:"];
const normalized = source
  .split("\n")
  .filter((line) => !branchRecordPrefixes.some((prefix) => line.startsWith(prefix)))
  .join("\n");

writeFileSync(path, normalized.endsWith("\n") ? normalized : `${normalized}\n`);
log(`Normalized ${path} to line coverage for SonarCloud.`);
