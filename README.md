# protocol-core

Solana programs for the Entros Protocol. Three Anchor programs handle Anchor minting, zero-knowledge verification, and protocol configuration.

## Programs

**entros-anchor** creates a non-transferable Token-2022 credential. It stores verification history and Trust Score in one wallet-derived `IdentityState` PDA.

Minting requires a validator-signed Ed25519 receipt. The receipt binds the wallet, commitment, and validation timestamp.

**entros-verifier** verifies Groth16 proofs and public inputs through `groth16-solana`. It also manages anti-replay challenge nonces.

**entros-registry** stores protocol configuration and validator-registration scaffolding. The devnet program accepts SOL deposits but does not select validators or distribute rewards.

## Devnet Program IDs

| Program | ID |
|---------|-----|
| entros-registry | `6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW` |
| entros-verifier | `4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV` |
| entros-anchor | `GZYwTp2ozeuRA5Gof9vs4ya961aANcJBdUzB7LN6q4b2` |

## Setup

```bash
# Prerequisites: Rust 1.91.0, Solana CLI 3.1.10, Anchor CLI 1.1.2, Node.js 24.15.0

# Install dependencies
npm ci

# Build all programs
anchor build

# Run the isolated Anchor integration suite
npm run test:localnet

# Run all LiteSVM suites
npm run test:litesvm

# Upgrade all three devnet programs with the registered admin authority
sh scripts/upgrade-devnet.sh
```

## Isolated devnet program builds

Builds use the listed program IDs by default. An isolated deployment requires the `request-bound-v1` feature and an explicit paired configuration.
Set `ENTROS_ISOLATED_PROGRAM_IDS` to an absolute JSON path with these fields:

```json
{
  "schemaVersion": 1,
  "cluster": "devnet",
  "consumerProgram": "<new Anchor program address>",
  "verifierProgram": "<new verifier program address>",
  "registryProgram": "6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW"
}
```

Replace both placeholders with distinct program addresses. The build rejects existing protocol addresses and requires the shared Registry.
The shared crate generates both program declarations and the verification-result account owner from this configuration.
Use the same configuration for both program builds and `anchor idl build`. Do not edit generated IDLs.

Provide matching `ENTROS_BOUND_DEPLOYMENT_CONFIG` and `ENTROS_BOUND_VERIFYING_KEY` inputs when enabling `request-bound-v1`.
The deployment configuration defines `DEPLOYMENT_DOMAIN`. The verifying-key input defines `VERIFYINGKEY`.
The client manifest must match the compiled program pair, deployment domain, genesis, and proof artifacts.
Changing the pair creates separate identity and request-state addresses. It does not migrate existing identities.

The isolated programs read the existing Registry configuration and pay normal verification fees to its treasury.
This build configuration does not change Registry policy or configure executor attestation issuance.

## Tests

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
anchor build --no-idl -- -- --locked
anchor build
npm run typecheck
npm run test:localnet
npm run test:litesvm
```

The integration suite covers:
- Identity minting (NonTransferable Token-2022, duplicate prevention, multi-user)
- Proof verification (valid/invalid proofs, challenge expiry, replay prevention)
- Registry (protocol initialization, validator registration scaffolding, Trust Score preview)
- End-to-end mint, challenge, proof, and Trust Score updates

Separate LiteSVM suites cover transfer restrictions, account migration, Trust Score rules, and compute behavior.

## License

MIT
