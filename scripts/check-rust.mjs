import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = readFileSync(
  new URL(
    "../tests/fixtures/request-bound-host-verifying-key.rs",
    import.meta.url,
  ),
);
const expectedHash =
  "afc7507275f04897c560f10face007c62a913152b1a7a02d24fc65502680be4d";
if (createHash("sha256").update(fixture).digest("hex") !== expectedHash) {
  throw new Error(
    "The host verification-key fixture does not match its pinned SHA-256.",
  );
}

const directory = mkdtempSync(join(tmpdir(), "entros-rust-host-checks-"));
const guard = `#[allow(unexpected_cfgs)]
mod host_fixture_only {
    #[cfg(any(target_os = "solana", target_arch = "bpf", target_arch = "sbf"))]
    compile_error!("Host-check fixtures cannot build Solana programs. Supply deployment artifacts explicitly.");
}
`;
const deployment = join(directory, "deployment.rs");
const verifyingKey = join(directory, "verifying-key.rs");
writeFileSync(
  deployment,
  `${guard}pub const DEPLOYMENT_DOMAIN: [u8; 32] = [0x11; 32];\n`,
  { flag: "wx" },
);
writeFileSync(verifyingKey, Buffer.concat([Buffer.from(guard), fixture]), {
  flag: "wx",
});

const environment = {
  ...process.env,
  ENTROS_BOUND_DEPLOYMENT_CONFIG: deployment,
  ENTROS_BOUND_VERIFYING_KEY: verifyingKey,
};
console.log(`Host-only Rust check inputs: ${directory}`);
for (const args of [
  ["fmt", "--all", "--", "--check"],
  [
    "clippy",
    "--workspace",
    "--all-targets",
    "--all-features",
    "--locked",
    "--",
    "-D",
    "warnings",
  ],
  ["test", "--workspace", "--all-features", "--locked"],
]) {
  const result = spawnSync("cargo", args, {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const configurationChecks = spawnSync(
  process.execPath,
  [join(root, "scripts/check-program-config.mjs")],
  { cwd: root, env: environment, stdio: "inherit" },
);
if (configurationChecks.error) throw configurationChecks.error;
if (configurationChecks.status !== 0)
  process.exit(configurationChecks.status ?? 1);
