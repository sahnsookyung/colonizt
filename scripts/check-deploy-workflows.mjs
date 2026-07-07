#!/usr/bin/env node
/* global console */
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const assertContains = (path, content, needle) => {
  if (!content.includes(needle)) {
    throw new Error(`${path} must contain ${needle}`);
  }
};

const assertMatches = (path, content, pattern, description) => {
  if (!pattern.test(content)) {
    throw new Error(`${path} must contain ${description}`);
  }
};

const deployWorkflowPath = ".github/workflows/deploy-production.yml";
const cdWorkflowPath = ".github/workflows/cd.yml";
const deployScriptPath = "ops/scripts/deploy-oci.sh";
const awaitGatesPath = "scripts/await-production-gates.mjs";

const deployWorkflow = read(deployWorkflowPath);
const cdWorkflow = read(cdWorkflowPath);
const deployScript = read(deployScriptPath);
const awaitGates = read(awaitGatesPath);

assertContains(deployWorkflowPath, deployWorkflow, "workflow_run:");
assertContains(deployWorkflowPath, deployWorkflow, 'workflows: ["CD - Build & Push Images"]');
assertContains(deployWorkflowPath, deployWorkflow, "workflow_dispatch:");
assertContains(deployWorkflowPath, deployWorkflow, "concurrency:");
assertContains(deployWorkflowPath, deployWorkflow, "group: colonizt-production");
assertMatches(deployWorkflowPath, deployWorkflow, /environment:\s*\n\s+name: production/, "the production environment");
assertContains(deployWorkflowPath, deployWorkflow, "scripts/await-production-gates.mjs");
assertContains(deployWorkflowPath, deployWorkflow, "CI=ci.yml");
assertContains(deployWorkflowPath, deployWorkflow, "SonarCloud=sonarcloud.yml");
assertContains(deployWorkflowPath, deployWorkflow, "CD image build=cd.yml");
assertContains(deployWorkflowPath, deployWorkflow, "COLONIZT_PRODUCTION_HOST");
assertContains(deployWorkflowPath, deployWorkflow, "COLONIZT_DEPLOY_KEY");
assertContains(deployWorkflowPath, deployWorkflow, "COLONIZT_PRODUCTION_ENV_B64");
assertContains(deployWorkflowPath, deployWorkflow, "docker manifest inspect \"ghcr.io/sahnsookyung/colonizt-server:${IMAGE_TAG}\"");
assertContains(deployWorkflowPath, deployWorkflow, "docker manifest inspect \"ghcr.io/sahnsookyung/colonizt-web:${IMAGE_TAG}\"");
assertContains(deployWorkflowPath, deployWorkflow, "./ops/scripts/deploy-oci.sh \"$COLONIZT_PRODUCTION_HOST\" \"$IMAGE_TAG\"");
assertContains(deployWorkflowPath, deployWorkflow, "./ops/scripts/smoke-oci.sh");
assertContains(deployWorkflowPath, deployWorkflow, "npm run smoke:deployed-browser");

assertContains(cdWorkflowPath, cdWorkflow, "ghcr.io/sahnsookyung/${{ matrix.image }}:${{ github.sha }}");
assertContains(cdWorkflowPath, cdWorkflow, "platforms: linux/arm64");

assertContains(deployScriptPath, deployScript, "Refusing to deploy mutable latest");
assertMatches(deployScriptPath, deployScript, /\[\[ ! "\$IMAGE_TAG" =~ \^\[0-9a-fA-F\]\{40\}\$ \]\]/, "a full 40-character image tag guard");
assertContains(awaitGatesPath, awaitGates, 'const ghExecutable = "/usr/bin/gh";');
if (awaitGates.includes('spawnSync("gh"')) {
  throw new Error(`${awaitGatesPath} must use a fixed gh executable path.`);
}

console.log("Validated production deploy workflow contract.");
