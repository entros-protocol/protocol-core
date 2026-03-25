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
}
