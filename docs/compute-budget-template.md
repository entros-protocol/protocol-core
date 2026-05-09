# Compute Budget

Default limit is 200,000 Compute Units (CU) per instruction.

The following CU values are ceilings (maximum expected values) used by the regression suite. Anything ≤ the listed value passes, anything > the listed value fails. Such ceilings are measured by running each of the LiteSVM tests 10 times and picking the maximum measured CU for each of our Solana write functions. Last verified: 2026-05-07.

## entros-anchor

| Instruction | CU Consumed | Headroom | Notes |
|-------------|-------------|----------|-------|
| mint_anchor | @mint_anchor@ | @mint_anchorH@ | Includes NonTransferable, MintCloseAuthority, MetadataPointer + TokenMetadata extension init |
| update_anchor | @update_anchor@ | @update_anchorH@ | Includes trust score computation + timestamp update |
| authorize_new_wallet | @authorize_new_wallet@ | @authorize_new_walletH@ | Included operations: add new signer in IdentityPDA, approve token delegate |
| migrate_identity | @migrate_identity@ | @migrate_identityH@ | Included operations: create new mint, setup token2022 extensions, initialize mint, create associated token account, mint 1 token, copy from old identity PDA, burn previous token, close old mint account, close old Identity PDA |
| reset_identity_state | @reset_identity_state@ | @reset_identity_stateH@ | User-initiated baseline recovery; writes new commitment, zeroes verification history, charges protocol fee, 7-day cooldown enforced. May realloc legacy accounts |

## entros-registry

| Instruction | CU Consumed | Headroom | Notes |
|-------------|-------------|----------|-------|
| initialize_protocol | @initialize_protocol@ | @initialize_protocolH@ | One-time admin setup |
| register_validator | @register_validator@ | @register_validatorH@ | Includes SOL stake transfer |
| compute_trust_score | @compute_trust_score@ | @compute_trust_scoreH@ | Pure computation, no state mutation |
| unstake_validator | @unstake_validator@ | @unstake_validatorH@ | Returns staked SOL |
| update_protocol_config | @update_protocol_config@ | @update_protocol_configH@ | Simple field update, may realloc |
| withdraw_treasury | @withdraw_treasury@ | @withdraw_treasuryH@ | SOL transfer from treasury |
| migrate_admin | @migrate_admin@ | @migrate_adminH@ | Simple field update + ProtocolConfig realloc + raw-byte admin write |
| set_validator_pubkey | @set_validator_pubkey@ | @set_validator_pubkeyH@ | Admin-only; writes validator signing pubkey to ProtocolConfig (offset 77) used by mint_anchor receipt verification. Realloc 77→109 bytes on first call against legacy account |

## entros-verifier

| Instruction | CU Consumed | Headroom | Notes |
|-------------|-------------|----------|-------|
| create_challenge | @create_challenge@ | @create_challengeH@ | Nonce validation + PDA creation |
| verify_proof | @verify_proof@ | @verify_proofH@ | Groth16 verification (heaviest instruction) |
| close_challenge | @close_challenge@ | @close_challengeH@ | Rent recovery, minimal logic |
| close_verification_result | @close_verification_result@ | @close_verification_resultH@ | Rent recovery, minimal logic |

## Batched Transaction Budget

The wallet-connected verification batches multiple instructions into a single transaction with a 250,000 CU budget request.

**Re-verification** (create_challenge + verify_proof + update_anchor):
@Re-verification@ CU consumed, @Re-verificationH@ headroom.

**First verification** (create_challenge + verify_proof + mint_anchor):
@First-verification@ CU consumed, @First-verificationH@ headroom.

First verification is the tightest path due to mint_anchor's Token-2022 account creation. Both paths fit within the 250K budget with margin.

## Mainnet Considerations

- verify_proof is the bottleneck at @verify_proof@ CU. Solana's default 200K limit accommodates it, but batched transactions need 250K (requested via ComputeBudgetProgram.setComputeUnitLimit).
- mint_anchor's Token-2022 extension stack (NonTransferable + MintCloseAuthority + MetadataPointer + TokenMetadata) accounts for the bulk of its @mint_anchor@ CU consumption.
- update_anchor consumes @update_anchor@ CU, dominated by trust score computation against the 52-slot timestamp array plus mint-receipt binding writes.
- All instructions well within Solana's 1.4M max requestable CU.
