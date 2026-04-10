use anchor_lang::prelude::*;

#[error_code]
pub enum VerifierError {
    #[msg("Invalid proof format")]
    InvalidProofFormat,
    #[msg("Proof verification failed")]
    ProofVerificationFailed,
    #[msg("Challenge has expired")]
    ChallengeExpired,
    #[msg("Challenge already used")]
    ChallengeAlreadyUsed,
    #[msg("Invalid public inputs")]
    InvalidPublicInputs,
    #[msg("Challenge must be used before closing")]
    ChallengeNotUsed,
    #[msg("Invalid nonce: must not be all zeros")]
    InvalidNonce,
}
