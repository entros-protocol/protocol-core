use anchor_lang::prelude::*;

#[account]
pub struct IdentityState {
    /// The user's wallet pubkey
    pub owner: Pubkey,
    /// When the identity was first minted
    pub creation_timestamp: i64,
    /// Most recent successful verification
    pub last_verification_timestamp: i64,
    /// Total successful verifications
    pub verification_count: u32,
    /// Computed reputation metric
    pub trust_score: u16,
    /// Latest Poseidon commitment H_TBH
    pub current_commitment: [u8; 32],
    /// The NonTransferable mint associated with this identity
    pub mint: Pubkey,
    /// PDA bump seed
    pub bump: u8,
    /// Timestamps of last 52 verifications (newest at index 0).
    /// 52 slots covers 1 year of weekly or 4+ years of monthly verifications.
    /// Older entries contribute negligible score due to exponential recency decay.
    pub recent_timestamps: [i64; 52],
    /// Most recent `reset_identity_state` invocation. Zero when the identity
    /// has never been reset (including freshly minted accounts and accounts
    /// created before this field existed and then realloc'd in-place).
    pub last_reset_timestamp: i64,
    /// new wallet for migrate_identity()
    pub new_wallet: Pubkey,
}

impl IdentityState {
    pub const LEN: usize = 8   // discriminator
        + 32  // owner
        + 8   // creation_timestamp
        + 8   // last_verification_timestamp
        + 4   // verification_count
        + 2   // trust_score
        + 32  // current_commitment
        + 32  // mint
        + 1   // bump
        + 416 // recent_timestamps (52 × 8 bytes)
        + 8   // last_reset_timestamp
        + 32; // new_wallet

    /// Pre-reset layout size. Used by `reset_identity_state` to detect legacy
    /// accounts that need realloc before the new field can be written.
    pub const LEN_PRE_RESET: usize = 543;
}

/// Wallet-keyed encrypted baseline blob, stored at PDA seeds
/// `[b"encrypted_baseline", wallet.key().as_ref()]`. Persists the user's
/// previous SimHash + salt across cache wipes and device changes so the
/// Hamming-distance ZK proof can recover its private witnesses on any
/// device with the originating wallet.
///
/// The blob is opaque ciphertext to the program — AES-256-GCM produced
/// off-chain in the SDK under a key derived from a deterministic
/// `signMessage` on a domain-separated payload. The GCM AAD binds the
/// blob to (wallet, this PDA's address, current on-chain commitment),
/// so a stale blob (post-`reset_identity_state`) fails authentication
/// against the new commitment and the SDK falls back to a fresh-capture
/// flow.
///
/// The program never decrypts the blob — it only stores opaque bytes.
/// Plaintext biometric data never reaches chain at any point.
#[account]
pub struct EncryptedBaseline {
    /// 96-byte versioned ciphertext envelope.
    /// Layout: version(1) || algo(1) || reserved(2) || iv(12) || ct+tag(80).
    pub blob: [u8; 96],
    /// PDA bump seed.
    pub bump: u8,
}

impl EncryptedBaseline {
    pub const LEN: usize = 8   // discriminator
        + 96  // blob
        + 1;  // bump
}
