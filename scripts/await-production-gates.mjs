#!/usr/bin/env node
/* global console, process, setTimeout */
import { spawnSync } from "node:child_process";

const activeStatuses = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);
const ghExecutable = "/usr/bin/gh";
const targetSha = process.argv[2];
const gateSpecs = process.argv.slice(3);
const timeoutSeconds = Number(process.env.AWAIT_WORKFLOW_GATES_TIMEOUT_SECONDS ?? 2700);
const pollSeconds = Number(process.env.AWAIT_WORKFLOW_GATES_POLL_SECONDS ?? 30);

if (!targetSha || !/^[0-9a-fA-F]{40}$/.test(targetSha)) {
  throw new Error("Usage: await-production-gates.mjs <full-40-char-sha> <label=workflow.yml>...");
}

if (gateSpecs.length === 0) {
  throw new Error("At least one workflow gate is required.");
}

const gates = gateSpecs.map((spec) => {
  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`Invalid gate spec "${spec}". Expected label=workflow.yml.`);
  }
  return {
    label: spec.slice(0, separator),
    workflow: spec.slice(separator + 1),
  };
});

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const listRuns = (workflow) => {
  const result = spawnSync(ghExecutable, [
    "run",
    "list",
    "--workflow",
    workflow,
    "--commit",
    targetSha,
    "--limit",
    "20",
    "--json",
    "conclusion,status,url,headSha,workflowName",
  ], { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(`gh run list failed for ${workflow}: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  return JSON.parse(result.stdout).filter((run) => run.headSha === targetSha);
};

const classifyRuns = (runs) => {
  const success = runs.find((run) => run.status === "completed" && run.conclusion === "success");
  if (success) return { state: "success", run: success };

  const active = runs.find((run) => activeStatuses.has(run.status));
  if (active || runs.length === 0) return { state: "pending", run: active };

  const completed = runs.find((run) => run.status === "completed") ?? runs[0];
  return { state: "failed", run: completed };
};

const waitForGate = async ({ label, workflow }) => {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() <= deadline) {
    const runs = listRuns(workflow);
    const result = classifyRuns(runs);

    if (result.state === "success") {
      console.log(`${label} passed for ${targetSha}: ${result.run.url}`);
      return;
    }

    if (result.state === "failed") {
      throw new Error(`${label} did not pass for ${targetSha}: ${result.run.conclusion ?? result.run.status} ${result.run.url ?? ""}`);
    }

    console.log(`${label} is not green yet for ${targetSha}; waiting ${pollSeconds}s...`);
    await sleep(pollSeconds * 1000);
  }

  throw new Error(`${label} did not become green within ${timeoutSeconds}s for ${targetSha}.`);
};

for (const gate of gates) {
  await waitForGate(gate);
}
