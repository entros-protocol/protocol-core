use anchor_lang::prelude::*;

#[error_code]
pub enum RegistryError {
    #[msg("Insufficient stake amount")]
    InsufficientStake,
    #[msg("Validator already registered")]
    ValidatorAlreadyRegistered,
    #[msg("Validator not active")]
    ValidatorNotActive,
    #[msg("Unauthorized: caller is not the expected authority")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Insufficient treasury balance for withdrawal")]
    InsufficientTreasuryBalance,
    #[msg("ProgramData bytes malformed")]
    ProgramDataBytes,
    #[msg("Caller is not the program upgrade authority")]
    WrongUpgradeAuthority,
    #[msg("Protocol config bytes malformed")]
    InvalidProtocolConfig,
    #[msg("Validator pubkey must be non-zero (zero pubkey would silently disable receipt binding)")]
    InvalidValidatorPubkey,
}
