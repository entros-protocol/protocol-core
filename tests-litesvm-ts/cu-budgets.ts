// Note: budgets bumped 2026-05-12 alongside the master-list #98 introduction
// of `init-if-needed` on entros-anchor. Enabling the feature in anchor-lang
// adds a small runtime preamble to every Anchor program in the workspace
// (~1-3% CU drift), so previously-tight budgets need a small headroom bump.
export const maxComputeBudgets = {
  //Registry
  initialize_protocol: 7500,
  register_validator: 26492,
  compute_trust_score: 5928,
  unstake_validator: 8873,
  update_protocol_config: 4700,
  withdraw_treasury: 7700,
  migrate_admin: 11140,
  set_validator_pubkey: 3332,
  //Anchor
  mint_anchor: 98985,
  update_anchor: 25643,
  authorize_new_wallet: 27485,
  migrate_identity: 115196,
  reset_identity_state: 30493,
  set_encrypted_baseline: 20000, // init_if_needed first-call ~17K, update ~10K
  //verifier
  create_challenge: 17922,
  verify_proof: 122973,
  close_challenge: 1767,
  close_verification_result: 1866,
};
