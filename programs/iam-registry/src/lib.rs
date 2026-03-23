#![deny(clippy::all)]

use anchor_lang::prelude::*;
use anchor_lang::system_program;

mod errors;
mod state;

use errors::RegistryError;
use state::{ProtocolConfig, ValidatorState};

/// Integer square root via Newton's method (deterministic, no floating point).
fn isqrt(n: u64) -> u64 {
    if n == 0 { return 0; }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

declare_id!("6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW");

#[program]
pub mod iam_registry {
    use super::*;

    /// Initialize the protocol configuration. One-time admin instruction.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        min_stake: u64,
        challenge_expiry: i64,
        max_trust_score: u16,
        base_trust_increment: u16,
    ) -> Result<()> {
        let config = &mut ctx.accounts.protocol_config;
        config.admin = ctx.accounts.admin.key();
        config.min_stake = min_stake;
        config.challenge_expiry = challenge_expiry;
        config.max_trust_score = max_trust_score;
        config.base_trust_increment = base_trust_increment;
        config.bump = ctx.bumps.protocol_config;
        Ok(())
    }

    /// Register as a validator by staking SOL.
    pub fn register_validator(ctx: Context<RegisterValidator>, stake_amount: u64) -> Result<()> {
        let config = &ctx.accounts.protocol_config;
        require!(
            stake_amount >= config.min_stake,
            RegistryError::InsufficientStake
        );

        // Transfer stake from validator to vault
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.validator.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            stake_amount,
        )?;

        let validator_state = &mut ctx.accounts.validator_state;
        validator_state.authority = ctx.accounts.validator.key();
        validator_state.stake = stake_amount;
        validator_state.registration_time = Clock::get()?.unix_timestamp;
        validator_state.is_active = true;
        validator_state.verifications_performed = 0;
        validator_state.bump = ctx.bumps.validator_state;

        emit!(ValidatorRegistered {
            authority: validator_state.authority,
            stake: stake_amount,
        });

        Ok(())
    }

    /// Compute progressive trust score from verification history and account age.
    ///
    /// The formula rewards consistency over time, not rapid repetition:
    /// - Each recent verification's contribution decays with age (30-day half-life)
    /// - Regularity bonus: consistent spacing between verifications scores higher
    /// - Age bonus: diminishing returns (sqrt) to prevent gaming via old unused accounts
    /// - A bot verifying 100 times in one day scores much lower than a human verifying weekly for months
    pub fn compute_trust_score(
        ctx: Context<ComputeTrustScore>,
        verification_count: u32,
        creation_timestamp: i64,
        recent_timestamps: [i64; 10],
    ) -> Result<()> {
        let config = &ctx.accounts.protocol_config;
        let now = Clock::get()?.unix_timestamp;

        // 1. Recency-weighted verification count
        // Smooth decay: 3000 / (30 + days_since) gives day 0 = 100, day 30 = 50, day 60 = 33
        let mut recency_score: u64 = 0;
        for ts in recent_timestamps.iter() {
            if *ts == 0 { continue; }
            let days_since = ((now - ts) / 86400).max(0) as u64;
            recency_score += 3000 / (30 + days_since);
        }
        let base_score = (recency_score / 100) * u64::from(config.base_trust_increment);

        // 2. Regularity bonus
        // Compute gaps between consecutive verifications using fixed array
        let mut gaps = [0i64; 9];
        let mut gaps_len = 0usize;
        for i in 0..9 {
            let a = recent_timestamps[i];
            let b = recent_timestamps[i + 1];
            if a > 0 && b > 0 {
                gaps[gaps_len] = (a - b) / 86400;
                gaps_len += 1;
            }
        }
        let regularity_bonus: u64 = if gaps_len >= 2 {
            let gap_slice = &gaps[..gaps_len];
            let mean_gap: i64 = gap_slice.iter().sum::<i64>() / gaps_len as i64;
            let variance: u64 = gap_slice.iter()
                .map(|g| ((g - mean_gap) * (g - mean_gap)) as u64)
                .sum::<u64>() / gaps_len as u64;
            let stddev = isqrt(variance);
            20u64.saturating_sub(stddev.min(20))
        } else {
            0
        };

        // 3. Age bonus with diminishing returns (integer sqrt, no f64)
        let age_seconds = now
            .checked_sub(creation_timestamp)
            .ok_or(RegistryError::ArithmeticOverflow)?;
        let age_days: u64 = (age_seconds / 86400).try_into().unwrap_or(0);
        let age_bonus = isqrt(age_days.min(365)) * 2;

        // 4. Combine
        let total = base_score
            .saturating_add(regularity_bonus)
            .saturating_add(age_bonus);

        let trust_score = total.min(u64::from(config.max_trust_score)) as u16;

        emit!(TrustScoreComputed {
            verification_count,
            creation_timestamp,
            trust_score,
        });

        Ok(())
    }
}

// --- Account Contexts ---

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = ProtocolConfig::LEN,
        seeds = [b"protocol_config"],
        bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterValidator<'info> {
    #[account(mut)]
    pub validator: Signer<'info>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = validator,
        space = ValidatorState::LEN,
        seeds = [b"validator", validator.key().as_ref()],
        bump,
    )]
    pub validator_state: Account<'info, ValidatorState>,

    /// CHECK: Vault PDA that holds staked SOL. No data deserialization needed.
    #[account(
        mut,
        seeds = [b"vault"],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ComputeTrustScore<'info> {
    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

// --- Events ---

#[event]
pub struct ValidatorRegistered {
    pub authority: Pubkey,
    pub stake: u64,
}

#[event]
pub struct TrustScoreComputed {
    pub verification_count: u32,
    pub creation_timestamp: i64,
    pub trust_score: u16,
}
