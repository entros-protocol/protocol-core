#![deny(clippy::all)]

use anchor_lang::prelude::*;

mod errors;
mod groth16_verifier;
#[cfg(test)]
mod mock_verifier;
mod state;
mod verifying_key;

use errors::VerifierError;
use state::{Challenge, VerificationResult};

declare_id!("4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV");

/// Default challenge expiry in seconds (5 minutes).
/// In production, this is read from ProtocolConfig via CPI.
const DEFAULT_CHALLENGE_EXPIRY: i64 = 300;

#[program]
pub mod iam_verifier {
    use super::*;

    /// Create a verification challenge with a client-generated nonce.
    pub fn create_challenge(ctx: Context<CreateChallenge>, nonce: [u8; 32]) -> Result<()> {
        require!(nonce != [0u8; 32], VerifierError::InvalidNonce);
        let now = Clock::get()?.unix_timestamp;

        let challenge = &mut ctx.accounts.challenge;
        challenge.challenger = ctx.accounts.challenger.key();
        challenge.nonce = nonce;
        challenge.created_at = now;
        challenge.expires_at = now + DEFAULT_CHALLENGE_EXPIRY;
        challenge.used = false;
        challenge.bump = ctx.bumps.challenge;

        emit!(ChallengeCreated {
            challenger: challenge.challenger,
            nonce,
            expires_at: challenge.expires_at,
        });

        Ok(())
    }

    /// Verify a proof against a challenge.
    /// Validates the challenge is unused and not expired, runs mock verification,
    /// and stores the result.
    pub fn verify_proof(
        ctx: Context<VerifyProof>,
        proof_bytes: Vec<u8>,
        public_inputs: Vec<[u8; 32]>,
        nonce: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let challenge = &mut ctx.accounts.challenge;

        // Validate challenge state
        require!(!challenge.used, VerifierError::ChallengeAlreadyUsed);
        require!(now < challenge.expires_at, VerifierError::ChallengeExpired);

        // Mark challenge as consumed
        challenge.used = true;

        // Run Groth16 verification — reverts the entire transaction on invalid proof
        groth16_verifier::verify_proof(&proof_bytes, &public_inputs)?;

        // Compute proof hash for audit trail
        // Rotate-and-XOR hash: each byte position rotates the accumulator
        // before XOR, preventing trivial collisions from byte reordering
        let mut proof_hash = [0u8; 32];
        for (i, &byte) in proof_bytes.iter().enumerate() {
            let pos = i % 32;
            proof_hash[pos] = proof_hash[pos].rotate_left(3) ^ byte;
        }

        // Store verification result (only reached for valid proofs)
        let result = &mut ctx.accounts.verification_result;
        result.verifier = ctx.accounts.verifier.key();
        result.proof_hash = proof_hash;
        result.verified_at = now;
        result.is_valid = true;
        result.challenge_nonce = nonce;
        result.bump = ctx.bumps.verification_result;

        emit!(VerificationComplete {
            verifier: result.verifier,
            is_valid: true,
            nonce,
        });

        Ok(())
    }

    /// Close a used or expired challenge account to reclaim rent.
    pub fn close_challenge(_ctx: Context<CloseChallenge>) -> Result<()> {
        Ok(())
    }

    /// Close a verification result account to reclaim rent.
    pub fn close_verification_result(_ctx: Context<CloseVerificationResult>) -> Result<()> {
        Ok(())
    }
}

// --- Account Contexts ---

#[derive(Accounts)]
#[instruction(nonce: [u8; 32])]
pub struct CreateChallenge<'info> {
    #[account(mut)]
    pub challenger: Signer<'info>,

    #[account(
        init,
        payer = challenger,
        space = Challenge::LEN,
        seeds = [b"challenge", challenger.key().as_ref(), nonce.as_ref()],
        bump,
    )]
    pub challenge: Account<'info, Challenge>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proof_bytes: Vec<u8>, public_inputs: Vec<[u8; 32]>, nonce: [u8; 32])]
pub struct VerifyProof<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>,

    #[account(
        mut,
        seeds = [b"challenge", verifier.key().as_ref(), nonce.as_ref()],
        bump = challenge.bump,
        constraint = challenge.challenger == verifier.key(),
    )]
    pub challenge: Account<'info, Challenge>,

    #[account(
        init,
        payer = verifier,
        space = VerificationResult::LEN,
        seeds = [b"verification", verifier.key().as_ref(), nonce.as_ref()],
        bump,
    )]
    pub verification_result: Account<'info, VerificationResult>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseChallenge<'info> {
    #[account(mut)]
    pub challenger: Signer<'info>,

    #[account(
        mut,
        close = challenger,
        constraint = challenge.challenger == challenger.key(),
        constraint = challenge.used @ VerifierError::ChallengeNotUsed,
    )]
    pub challenge: Account<'info, Challenge>,
}

#[derive(Accounts)]
pub struct CloseVerificationResult<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>,

    #[account(
        mut,
        close = verifier,
        constraint = verification_result.verifier == verifier.key(),
    )]
    pub verification_result: Account<'info, VerificationResult>,
}

// --- Events ---

#[event]
pub struct ChallengeCreated {
    pub challenger: Pubkey,
    pub nonce: [u8; 32],
    pub expires_at: i64,
}

#[event]
pub struct VerificationComplete {
    pub verifier: Pubkey,
    pub is_valid: bool,
    pub nonce: [u8; 32],
}
