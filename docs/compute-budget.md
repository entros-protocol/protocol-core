# Compute Budget

Measured via `sol_log_compute_units()` on localnet with `anchor test`. Default limit is 200,000 CU per instruction. Ranges reflect variance across multiple test runs. Last verified: 2026-04-18.

## entros-anchor

| Instruction | CU Consumed | Headroom | Notes |
|-------------|-------------|----------|-------|
| mint_anchor | 79.5K | 120K | Range from Token-2022 account creation variance |
| update_anchor | 6,778 | ~193K | Includes trust score computation + timestamp update |
| authorize_new_wallet | 15,485 | 185K | Included operations: add new signer in IdentityPDA, approve token delegate |
| migrate_identity | 98.8K | 101K | Included operations: create new mint, setup token2022 extensions, initialize mint, create associated token account, mint 1 token, copy from old identity PDA, burn previous token, close old mint account, close old Identity PDA |

## entros-registry

| Instruction | CU Consumed | Headroom | Notes |
|-------------|-------------|----------|-------|
| initialize_protocol | 6,796 | ~193K | One-time admin setup |
| register_validator | 14,466 - 18,966 | ~181K - 186K | Includes SOL stake transfer |
| compute_trust_score | 3,449 - 5,928 | ~194K - 197K | Pure computation, no state mutation |
| unstake_validator | 8,873 | ~191K | Returns staked SOL |
| update_protocol_config | 4508 | 195K | Simple field update, may realloc |
| withdraw_treasury | 7526 | 192K | SOL transfer from treasury |
| migrate_admin | 11140 | 189K | Simple field update + ProtocolConfig realloc + raw-byte admin write |

## entros-verifier

| Instruction | CU Consumed | Headroom | Notes |
|-------------|-------------|----------|-------|
| create_challenge | 7,523 - 13,523 | ~187K - 193K | Nonce validation + PDA creation |
| verify_proof | 109,097 - 113,603 | ~87K - 91K | Groth16 verification (heaviest instruction) |
| close_challenge | 1767 | 198K | Rent recovery, minimal logic |
| close_verification_result | 1866 | 198K | Rent recovery, minimal logic |

## Batched Transaction Budget

The wallet-connected verification batches multiple instructions into a single transaction with a 250,000 CU budget request.

**Re-verification** (create_challenge + verify_proof + update_anchor):
~124K - 134K CU consumed, ~116K - 126K headroom.

**First verification** (create_challenge + verify_proof + mint_anchor):
~163K - 186K CU consumed, ~64K - 87K headroom.

First verification is the tighter path due to mint_anchor's Token-2022 account creation. Both paths fit within the 250K budget with margin.

## Mainnet Considerations

- verify_proof is the bottleneck at ~110K CU. Solana's default 200K limit accommodates it, but batched transactions need 250K (requested via ComputeBudgetProgram.setComputeUnitLimit).
- Token-2022 operations in mint_anchor add ~12K CU overhead vs standard SPL Token.
- Trust score computation in update_anchor scales with the 52-slot timestamp array but stays under 7K CU even at capacity.
- All instructions well within Solana's 1.4M max requestable CU.
