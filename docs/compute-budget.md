# Compute Budget

Default limit is 200,000 Compute Units (CU) per instruction.

The following CU values are ceilings (maximum expected values) used by the regression suite. Anything ≤ the listed value passes, anything > the listed value fails. Such ceilings are measured by running each of the LiteSVM tests 10 times and picking the maximum measured CU for each of our Solana write functions. Last verified: 2026-05-07.

## entros-anchor

| Instruction | CU Consumed | Headroom | Notes |
|-------------|-------------|----------|-------|
| mint_anchor | 98.98K | 101.02K | Includes NonTransferable, MintCloseAuthority, MetadataPointer + TokenMetadata extension init |
| update_anchor | 25.64K | 174.36K | Includes trust score computation + timestamp update |
| authorize_new_wallet | 27.48K | 172.51K | Included operations: add new signer in IdentityPDA, approve token delegate |
| migrate_identity | 115.2K | 84.8K | Included operations: create new mint, setup token2022 extensions, initialize mint, create associated token account, mint 1 token, copy from old identity PDA, burn previous token, close old mint account, close old Identity PDA |
| reset_identity_state | 30.49K | 169.51K | User-initiated baseline recovery; writes new commitment, zeroes verification history, charges protocol fee, 7-day cooldown enforced. May realloc legacy accounts |

## entros-registry

| Instruction | CU Consumed | Headroom | Notes |
|-------------|-------------|----------|-------|
| initialize_protocol | 6.96K | 193.04K | One-time admin setup |
| register_validator | 26.49K | 173.51K | Includes SOL stake transfer |
| compute_trust_score | 5.93K | 194.07K | Pure computation, no state mutation |
| unstake_validator | 8.87K | 191.13K | Returns staked SOL |
| update_protocol_config | 4.62K | 195.38K | Simple field update, may realloc |
| withdraw_treasury | 7.59K | 192.41K | SOL transfer from treasury |
| migrate_admin | 11.14K | 188.86K | Simple field update + ProtocolConfig realloc + raw-byte admin write |
| set_validator_pubkey | 3.33K | 196.67K | Admin-only; writes validator signing pubkey to ProtocolConfig (offset 77) used by mint_anchor receipt verification. Realloc 77→109 bytes on first call against legacy account |

## entros-verifier

| Instruction | CU Consumed | Headroom | Notes |
|-------------|-------------|----------|-------|
| create_challenge | 17.92K | 182.08K | Nonce validation + PDA creation |
| verify_proof | 122.97K | 77.03K | Groth16 verification (heaviest instruction) |
| close_challenge | 1.77K | 198.23K | Rent recovery, minimal logic |
| close_verification_result | 1.87K | 198.13K | Rent recovery, minimal logic |

## Batched Transaction Budget

The wallet-connected verification batches multiple instructions into a single transaction with a 250,000 CU budget request.

**Re-verification** (create_challenge + verify_proof + update_anchor):
166.54K CU consumed, 83.46K headroom.

**First verification** (create_challenge + verify_proof + mint_anchor):
239.88K CU consumed, 10.12K headroom.

First verification is the tightest path due to mint_anchor's Token-2022 account creation. Both paths fit within the 250K budget with margin.

## Mainnet Considerations

- verify_proof is the bottleneck at 122.97K CU. Solana's default 200K limit accommodates it, but batched transactions need 250K (requested via ComputeBudgetProgram.setComputeUnitLimit).
- mint_anchor's Token-2022 extension stack (NonTransferable + MintCloseAuthority + MetadataPointer + TokenMetadata) accounts for the bulk of its 98.98K CU consumption.
- update_anchor consumes 25.64K CU, dominated by trust score computation against the 52-slot timestamp array plus mint-receipt binding writes.
- All instructions well within Solana's 1.4M max requestable CU.
