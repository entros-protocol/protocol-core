import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "entros-program-config-tests-"));
const valid = {
  schemaVersion: 1,
  cluster: "devnet",
  consumerProgram: "32ZsJ2yJjwuoBiWE5xnZjG9tKmK3CubbmEzgkQLyQzgD",
  verifierProgram: "36VASLSKLFD2KokjXG7V28veZvXEsyHRKefLonPaAKzv",
  registryProgram: "6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW",
};
const deployment = join(directory, "deployment.rs");
writeFileSync(
  deployment,
  "pub const DEPLOYMENT_DOMAIN: [u8; 32] = [0x11; 32];\n",
  { flag: "wx" },
);

const cases = [
  ["default", undefined, false, undefined],
  ["valid pair", valid, true, undefined],
  ["missing feature", valid, false, "requires request-bound-v1"],
  [
    "missing verifier",
    { ...valid, verifierProgram: undefined },
    true,
    "missing field",
  ],
  [
    "same address",
    { ...valid, verifierProgram: valid.consumerProgram },
    true,
    "addresses must differ",
  ],
  [
    "official Anchor",
    {
      ...valid,
      consumerProgram: "GZYwTp2ozeuRA5Gof9vs4ya961aANcJBdUzB7LN6q4b2",
    },
    true,
    "must differ from existing",
  ],
  [
    "official verifier",
    {
      ...valid,
      verifierProgram: "4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV",
    },
    true,
    "must differ from existing",
  ],
  [
    "foreign Registry",
    { ...valid, registryProgram: valid.consumerProgram },
    true,
    "retain the existing Registry",
  ],
  [
    "mainnet",
    { ...valid, cluster: "mainnet-beta" },
    true,
    "schemaVersion 1 and devnet",
  ],
  [
    "unknown schema",
    { ...valid, schemaVersion: 2 },
    true,
    "schemaVersion 1 and devnet",
  ],
  [
    "unknown field",
    { ...valid, consumerProgam: valid.consumerProgram },
    true,
    "unknown field",
  ],
  [
    "short address",
    { ...valid, consumerProgram: "111" },
    true,
    "canonical 32-byte base58",
  ],
  [
    "system address",
    { ...valid, consumerProgram: "11111111111111111111111111111111" },
    true,
    "must differ from existing",
  ],
];

for (const [index, [name, config, bound, error]] of cases.entries()) {
  const environment = {
    ...process.env,
    ENTROS_BOUND_DEPLOYMENT_CONFIG: deployment,
  };
  delete environment.ENTROS_ISOLATED_PROGRAM_IDS;
  if (config) {
    const filename = join(directory, `${index}.json`);
    writeFileSync(filename, JSON.stringify(config), { flag: "wx" });
    environment.ENTROS_ISOLATED_PROGRAM_IDS = filename;
  }
  const result = spawnSync(
    "cargo",
    [
      "check",
      "--offline",
      "--locked",
      "-p",
      "entros-proof-request",
      ...(bound ? ["--features", "request-bound-v1"] : []),
    ],
    { cwd: root, env: environment, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`;
  if (error) {
    assert.notEqual(result.status, 0, `${name} unexpectedly compiled`);
    assert.ok(output.includes(error), `${name}: ${output}`);
  } else {
    assert.equal(result.status, 0, `${name}: ${output}`);
  }
  console.log(`PASS: ${name}`);
}
