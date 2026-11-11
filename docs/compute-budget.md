# Compute Budget

Default limit is 200,000 Compute Units (CU) per instruction.

The following CU values are ceilings (maximum expected values) used by the regression suite. Anything ≤ the listed value passes, anything > the listed value fails. Such ceilings are measured by running each of the LiteSVM tests 10 times and picking the maximum measured CU for each of our Solana write functions.

## entros-anchor

| Instruction | CU Consumed | Headroom | Notes |
|-------------|-------------|----------|-------|
| mint_anchor | 85.12K | 114.88K | Includes NonTransferable, MintCloseAuthority, MetadataPointer + TokenMetadata extension init |
| update_anchor | 25.64K | 174.36K | Includes trust score computation + timestamp update |
| authorize_new_wallet | 30.46K | 169.53K | Included operations: add new signer in IdentityPDA, approve token delegate |
| migrate_identity | 124.87K | 75.13K | Included operations: create new mint, setup token2022 extensions, initialize mint, create associated token account, mint 1 token, copy from old identity PDA, write the migration record, burn previous token, close old mint account, close old Identity PDA |
| reset_identity_state | 30.49K | 169.51K | User-initiated baseline recovery; writes new commitment, zeroes verification history, charges protocol fee, 7-day cooldown enforced. May realloc legacy accounts |
| rebaseline_anchor | 19K | 181K | Moves an identity to the current projection under a validator receipt; 7-day cooldown |
| set_encrypted_baseline | 20K | 180K | Writes the encrypted baseline blob; creates the account on first call |

## entros-registry

| Instruction | CU Consumed | Headroom | Notes |
|-------------|-------------|----------|-------|
| initialize_protocol | 7.5K | 192.5K | One-time admin setup |
| register_validator | 26.49K | 173.51K | Includes SOL stake transfer |
| compute_trust_score | 5.93K | 194.07K | Pure computation, no state mutation |
| unstake_validator | 8.87K | 191.13K | Returns staked SOL |
| update_protocol_config | 5.8K | 194.2K | Simple field update, may realloc |
| withdraw_treasury | 7.8K | 192.2K | SOL transfer from treasury |
| migrate_admin | 11.14K | 188.86K | Simple field update + ProtocolConfig realloc + raw-byte admin write |
| set_validator_pubkey | 3.7K | 196.3K | Admin-only; writes validator signing pubkey to ProtocolConfig (offset 77) used by mint_anchor receipt verification. Realloc 77→109 bytes on first call against legacy account |
| set_projection_versions | 6K | 194K | Admin-only; sets the current and minimum projection versions, may realloc |

## entros-verifier

| Instruction | CU Consumed | Headroom | Notes |
|-------------|-------------|----------|-------|
| create_challenge | 23K | 177K | Nonce validation + PDA creation |
| verify_proof | 122.97K | 77.03K | Groth16 verification (heaviest instruction) |
| verify_proof_compact | 122.22K | 77.78K | Groth16 verification with compact public inputs |
| close_challenge | 2.45K | 197.55K | Rent recovery, minimal logic |
| close_verification_result | 2.55K | 197.45K | Rent recovery, minimal logic |

## Batched Transaction Budget

The wallet-connected verification batches multiple instructions into a single transaction with a 250,000 CU budget request.

**Re-verification** (create_challenge + verify_proof + update_anchor):
171.62K CU consumed, 78.38K headroom.

**First verification** (create_challenge + verify_proof + mint_anchor):
231.1K CU consumed, 18.9K headroom.

First verification is the tightest path due to mint_anchor's Token-2022 account creation. Both paths fit within the 250K budget with margin.

## Mainnet Considerations

- verify_proof is the bottleneck at 122.97K CU. Solana's default 200K limit accommodates it, but batched transactions need 250K (requested via ComputeBudgetProgram.setComputeUnitLimit).
- mint_anchor's Token-2022 extension stack (NonTransferable + MintCloseAuthority + MetadataPointer + TokenMetadata) accounts for the bulk of its 85.12K CU consumption.
- update_anchor consumes 25.64K CU, dominated by trust score computation against the 52-slot timestamp array plus mint-receipt binding writes.
- All instructions well within Solana's 1.4M max requestable CU.
