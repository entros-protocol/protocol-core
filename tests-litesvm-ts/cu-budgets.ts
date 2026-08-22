// Keep each ceiling close to the measured instruction cost.
export const maxComputeBudgets = {
  //Registry
  initialize_protocol: 7500,
  register_validator: 26492,
  compute_trust_score: 5928,
  unstake_validator: 8873,
  update_protocol_config: 5400,
  withdraw_treasury: 7800,
  migrate_admin: 11140,
  set_validator_pubkey: 3400,
  set_projection_versions: 6000,
  //Anchor
  mint_anchor: 98985,
  update_anchor: 25643,
  authorize_new_wallet: 30465,
  migrate_identity: 115196,
  reset_identity_state: 30493,
  set_encrypted_baseline: 20000, // init_if_needed first-call ~17K, update ~10K
  //verifier
  create_challenge: 17922,
  verify_proof: 122973,
  close_challenge: 2450,
  close_verification_result: 2550,
};
