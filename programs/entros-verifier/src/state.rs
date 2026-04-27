use anchor_lang::prelude::*;

#[account]
pub struct Challenge {
    /// The user who requested the challenge
    pub challenger: Pubkey,
    /// Random nonce for anti-replay
    pub nonce: [u8; 32],
    /// Unix timestamp when challenge was created
    pub created_at: i64,
    /// Unix timestamp when challenge expires
    pub expires_at: i64,
    /// Whether this challenge has been consumed
    pub used: bool,
    /// PDA bump seed
    pub bump: u8,
}

impl Challenge {
    pub const LEN: usize = 8  // discriminator
        + 32  // challenger
        + 32  // nonce
        + 8   // created_at
        + 8   // expires_at
        + 1   // used
        + 1; // bump
}

#[account]
pub struct VerificationResult {
    /// Who submitted the proof
    pub verifier: Pubkey,
    /// Hash of the proof bytes for audit trail
    pub proof_hash: [u8; 32],
    /// Unix timestamp of verification
    pub verified_at: i64,
    /// Whether the proof was valid.
    /// Always true for persisted records — invalid proofs revert the transaction
    /// and never create a VerificationResult. Retained for account layout stability.
    pub is_valid: bool,
    /// The challenge nonce that was consumed
    pub challenge_nonce: [u8; 32],
    /// PDA bump seed
    pub bump: u8,
    /// New fingerprint commitment from public_inputs[0]. Read cross-program
    /// by entros-anchor::update_anchor to bind the proof to the identity update.
    pub commitment_new: [u8; 32],
    /// Previous fingerprint commitment from public_inputs[1]. Read cross-program
    /// by entros-anchor::update_anchor to bind to the identity's stored commitment.
    pub commitment_prev: [u8; 32],
    /// Hamming threshold from public_inputs[2]. Bounded at proof time to prevent
    /// attacker-chosen circuit parameters.
    pub threshold: u16,
    /// Hamming min_distance from public_inputs[3]. Bounded at proof time to
    /// prevent replay (Hamming=0) attacks via attacker-chosen min_distance=0.
    pub min_distance: u16,
}

impl VerificationResult {
    pub const LEN: usize = 8  // discriminator
        + 32  // verifier
        + 32  // proof_hash
        + 8   // verified_at
        + 1   // is_valid
        + 32  // challenge_nonce
        + 1   // bump
        + 32  // commitment_new
        + 32  // commitment_prev
        + 2   // threshold
        + 2; // min_distance

    /// Legacy layout size (pre-binding patch). Accounts created before the
    /// 2026-04-20 upgrade have this size and are rejected by update_anchor
    /// via a length check that requires LEN (the new, larger size).
    pub const LEN_V1: usize = 114;
}
