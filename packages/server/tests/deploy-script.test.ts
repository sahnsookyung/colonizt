import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const deployScript = join(repoRoot, "ops/scripts/deploy-oci.sh");
const temporaryDirectories: string[] = [];

const temporaryDeployEnvironment = () => {
  const directory = mkdtempSync(join(tmpdir(), "colonizt-deploy-test-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const log = join(directory, "ssh.log");
  const failedOnce = join(directory, "failed-once");
  const envFile = join(directory, "colonizt.env");
  const knownHosts = join(directory, "known_hosts");
  writeFileSync(envFile, "POSTGRES_PASSWORD=test-only\n");
  writeFileSync(knownHosts, "203.0.113.20 ssh-ed25519 AAAAC3Nza-test-pinned-key\n");
  spawnSync("mkdir", ["-p", bin], { stdio: "inherit" });
  const ssh = join(bin, "ssh");
  writeFileSync(ssh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_SSH_LOG"
command="\${!#}"
if [[ "$command" == *"docker compose"*"up -d --remove-orphans"* && ! -e "$FAKE_FAILED_ONCE" ]]; then
  : > "$FAKE_FAILED_ONCE"
  exit 1
fi
`);
  chmodSync(ssh, 0o755);
  const scp = join(bin, "scp");
  writeFileSync(scp, "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n");
  chmodSync(scp, 0o755);
  const curl = join(bin, "curl");
  writeFileSync(curl, "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n");
  chmodSync(curl, 0o755);
  return { directory, bin, envFile, knownHosts, log, failedOnce };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OCI deploy rollback", () => {
  it("restores the prior compose files and image set after application startup fails", () => {
    const fixture = temporaryDeployEnvironment();
    const result = spawnSync("bash", [deployScript, "203.0.113.20", "a".repeat(40)], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
        COLONIZT_ENV_FILE: fixture.envFile,
        COLONIZT_SSH_KNOWN_HOSTS_FILE: fixture.knownHosts,
        FAKE_SSH_LOG: fixture.log,
        FAKE_FAILED_ONCE: fixture.failedOnce,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Restoring previous Colonizt compose configuration and stack");
    const sshLog = readFileSync(fixture.log, "utf8");
    expect(sshLog).toContain("rollback-");
    expect(sshLog).toContain("install -m 0600 /srv/colonizt/deploy/rollback-");
    expect(sshLog).toContain("install -m 0644 /srv/colonizt/deploy/rollback-");
    expect(sshLog.match(/up -d --remove-orphans/g)).toHaveLength(2);
    expect(sshLog).toContain("StrictHostKeyChecking=yes");
    expect(sshLog).toContain(`UserKnownHostsFile=${fixture.knownHosts}`);
  });

  it("fails before any network action when no pinned host key is configured", () => {
    const fixture = temporaryDeployEnvironment();
    writeFileSync(fixture.knownHosts, "");
    const result = spawnSync("bash", [deployScript, "203.0.113.20", "b".repeat(40)], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
        COLONIZT_ENV_FILE: fixture.envFile,
        COLONIZT_SSH_KNOWN_HOSTS_FILE: fixture.knownHosts,
        FAKE_SSH_LOG: fixture.log,
        FAKE_FAILED_ONCE: fixture.failedOnce,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is missing or empty; pin the production SSH host key");
    expect(() => readFileSync(fixture.log, "utf8")).toThrow();
  });
});
