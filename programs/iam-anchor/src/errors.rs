use anchor_lang::prelude::*;

#[error_code]
pub enum IamAnchorError {
    #[msg("Invalid commitment: must be 32 non-zero bytes")]
    InvalidCommitment,
    #[msg("Unauthorized: caller is not the identity owner")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Invalid protocol config account")]
    InvalidProtocolConfig,
    #[msg("Identity state account failed to deserialize")]
    InvalidIdentityState,
    #[msg("Identity state account failed to serialize")]
    IdentitySerializationFailed,
    #[msg("VerificationResult account is owned by the wrong program")]
    VerificationResultWrongOwner,
    #[msg("VerificationResult account has stale layout (pre-binding-patch)")]
    StaleVerificationResult,
    #[msg("VerificationResult verifier does not match the signing authority")]
    VerifierMismatch,
    #[msg("Proof is too old to consume (MAX_PROOF_AGE_SECS exceeded)")]
    ProofExpired,
    #[msg("Proof commitment_new does not match the submitted new_commitment")]
    CommitmentMismatch,
    #[msg("Proof commitment_prev does not match the identity's current_commitment")]
    PrevCommitmentMismatch,
}
