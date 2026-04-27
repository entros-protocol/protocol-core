use anchor_lang::prelude::*;

#[account]
pub struct ProtocolConfig {
    /// The authority that can update protocol parameters
    pub admin: Pubkey,
    /// Minimum SOL lamports to stake as a validator
    pub min_stake: u64,
    /// Seconds until a challenge nonce expires
    pub challenge_expiry: i64,
    /// Maximum achievable trust score (e.g. 10000 = 100.00%)
    pub max_trust_score: u16,
    /// Trust score points awarded per verification
    pub base_trust_increment: u16,
    /// PDA bump seed
    pub bump: u8,
    /// Lamports charged per verification (user-pays model)
    pub verification_fee: u64,
    pub migration_fee: u64,
}

impl ProtocolConfig {
    pub const LEN: usize = 8 // discriminator
        + 32  // admin
        + 8   // min_stake
        + 8   // challenge_expiry
        + 2   // max_trust_score
        + 2   // base_trust_increment
        + 1   // bump
        + 8   // verification_fee
        + 8;  // migration_fee
}

#[account]
pub struct ValidatorState {
    /// The validator's wallet
    pub authority: Pubkey,
    /// Lamports staked
    pub stake: u64,
    /// Unix timestamp of registration
    pub registration_time: i64,
    /// Whether the validator is currently active
    pub is_active: bool,
    /// Total verifications performed
    pub verifications_performed: u64,
    /// PDA bump seed
    pub bump: u8,
}

impl ValidatorState {
    pub const LEN: usize = 8 // discriminator
        + 32  // authority
        + 8   // stake
        + 8   // registration_time
        + 1   // is_active
        + 8   // verifications_performed
        + 1; // bump
}
