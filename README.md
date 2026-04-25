# protocol-core

Solana on-chain programs for the Entros Protocol. Three Anchor programs handle identity minting, ZK proof verification, and protocol governance.

## Programs

**entros-anchor** — Non-transferable identity token. Creates a Token-2022 mint with the NonTransferable extension, mints one token per user, and manages an IdentityState PDA that tracks verification history and Trust Score.

**entros-verifier** — ZK proof verification. Accepts Groth16 proofs and public inputs, verifies them on-chain via `groth16-solana`, and manages challenge nonces for anti-replay.

**entros-registry** — Protocol configuration and validator management. Stores protocol parameters (trust score weights, challenge expiry, max stake) and handles validator registration with SOL staking.

## Devnet Program IDs

| Program | ID |
|---------|-----|
| entros-registry | `6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW` |
| entros-verifier | `4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV` |
| entros-anchor | `GZYwTp2ozeuRA5Gof9vs4ya961aANcJBdUzB7LN6q4b2` |

## Setup

```bash
# Prerequisites: Rust, Solana CLI >= 3.0, Anchor CLI >= 0.32, Node.js >= 20

# Install dependencies
npm install

# Build all programs
anchor build

# Run tests (starts a local validator, deploys, runs 16 integration tests)
anchor test

# Deploy to devnet
solana config set --url devnet
anchor deploy --provider.cluster devnet
```

## Tests

```bash
anchor test
```

16 tests covering:
- Identity minting (NonTransferable Token-2022, duplicate prevention, multi-user)
- Proof verification (valid/invalid proofs, challenge expiry, replay prevention)
- Registry (protocol initialization, validator staking, trust score computation)
- End-to-end flow (mint → challenge → verify → update trust score)

## License

MIT
