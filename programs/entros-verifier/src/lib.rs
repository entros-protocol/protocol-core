#![deny(clippy::all)]
#![cfg_attr(feature = "cpi", allow(clippy::too_many_arguments))]
#![allow(unexpected_cfgs)] // Anchor emits SBF-only cfg values during host builds.

use anchor_lang::prelude::*;
use solana_security_txt::security_txt;

mod bound;
mod errors;
use bound::*;
mod groth16_verifier;
#[cfg(test)]
mod mock_verifier;
mod state;
#[rustfmt::skip]
mod verifying_key;

use errors::VerifierError;
use state::{Challenge, VerificationResult};

declare_id!("4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV");

security_txt! {
    name: "Entros Verifier",
    project_url: "https://entros.io",
    contacts: "email:contact@entros.io",
    policy: "https://entros.io/security",
    source_code: "https://github.com/entros-protocol/protocol-core"
}

/// Default challenge expiry in seconds (5 minutes).
/// In production, this is read from ProtocolConfig via CPI.
const DEFAULT_CHALLENGE_EXPIRY: i64 = 300;

/// Highest Hamming threshold input accepted by this program.
/// Client defaults do not change this ceiling.
#[constant]
pub const MAX_THRESHOLD: u16 = 96;

/// Lowest minimum-distance input accepted by this program.
/// Client defaults do not change this floor.
#[constant]
pub const MIN_DISTANCE_FLOOR: u16 = 3;

#[program]
pub mod entros_verifier {
    use super::*;

    /// Create a verification challenge with a client-generated nonce.
    pub fn create_challenge(ctx: Context<CreateChallenge>, nonce: [u8; 32]) -> Result<()> {
        require!(nonce != [0u8; 32], VerifierError::InvalidNonce);
        let now = Clock::get()?.unix_timestamp;

        let challenge = &mut ctx.accounts.challenge;
        challenge.challenger = ctx.accounts.challenger.key();
        challenge.nonce = nonce;
        challenge.created_at = now;
        challenge.expires_at = now
            .checked_add(DEFAULT_CHALLENGE_EXPIRY)
            .ok_or(VerifierError::ArithmeticOverflow)?;
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
        let public_inputs: [[u8; 32]; 4] = public_inputs
            .try_into()
            .map_err(|_| VerifierError::InvalidPublicInputs)?;
        verify_and_store(
            &ctx.accounts.verifier,
            &mut ctx.accounts.challenge,
            &mut ctx.accounts.verification_result,
            &proof_bytes,
            &public_inputs,
            nonce,
            ctx.bumps.verification_result,
        )
    }

    /// Verify a proof with fixed-size arguments.
    pub fn verify_proof_compact(
        ctx: Context<VerifyProofCompact>,
        nonce: [u8; 32],
        proof_bytes: [u8; 256],
        commitment_new: [u8; 32],
        commitment_prev: [u8; 32],
        threshold: u16,
        min_distance: u16,
    ) -> Result<()> {
        let public_inputs = [
            commitment_new,
            commitment_prev,
            encode_u16_field_element(threshold),
            encode_u16_field_element(min_distance),
        ];
        verify_and_store(
            &ctx.accounts.verifier,
            &mut ctx.accounts.challenge,
            &mut ctx.accounts.verification_result,
            &proof_bytes,
            &public_inputs,
            nonce,
            ctx.bumps.verification_result,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn verify_proof_bound(
        ctx: Context<VerifyProofBound>,
        nonce: [u8; 32],
        proof_bytes: [u8; 256],
        commitment_new: [u8; 32],
        commitment_prev: [u8; 32],
        threshold: u16,
        min_distance: u16,
        valid_until: u64,
    ) -> Result<()> {
        bound::verify(
            ctx,
            nonce,
            proof_bytes,
            commitment_new,
            commitment_prev,
            threshold,
            min_distance,
            valid_until,
        )
    }

    pub fn close_bound_verification_result(
        _ctx: Context<CloseBoundVerificationResult>,
        _nonce: [u8; 32],
    ) -> Result<()> {
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

fn verify_and_store<'info>(
    verifier: &Signer<'info>,
    challenge: &mut Account<'info, Challenge>,
    result: &mut Account<'info, VerificationResult>,
    proof_bytes: &[u8],
    public_inputs: &[[u8; 32]; 4],
    nonce: [u8; 32],
    verification_result_bump: u8,
) -> Result<()> {
    require!(
        !cfg!(feature = "request-bound-v1"),
        VerifierError::UnsupportedProofGeneration
    );
    let now = Clock::get()?.unix_timestamp;

    require!(!challenge.used, VerifierError::ChallengeAlreadyUsed);
    require!(now < challenge.expires_at, VerifierError::ChallengeExpired);
    challenge.used = true;

    require!(
        public_inputs[0] != [0u8; 32],
        VerifierError::InvalidPublicInputs
    );
    require!(
        public_inputs[1] != [0u8; 32],
        VerifierError::InvalidPublicInputs
    );
    let threshold = decode_u16_from_field_element(&public_inputs[2])?;
    let min_distance = decode_u16_from_field_element(&public_inputs[3])?;
    validate_hamming_bounds(threshold, min_distance)?;

    groth16_verifier::verify_proof(proof_bytes, public_inputs)?;

    let mut proof_hash = [0u8; 32];
    for (i, &byte) in proof_bytes.iter().enumerate() {
        let position = i % proof_hash.len();
        proof_hash[position] = proof_hash[position].rotate_left(3) ^ byte;
    }

    result.verifier = verifier.key();
    result.proof_hash = proof_hash;
    result.verified_at = now;
    result.is_valid = true;
    result.challenge_nonce = nonce;
    result.bump = verification_result_bump;
    result.commitment_new = public_inputs[0];
    result.commitment_prev = public_inputs[1];
    result.threshold = threshold;
    result.min_distance = min_distance;

    emit!(VerificationComplete {
        verifier: result.verifier,
        is_valid: true,
        nonce,
    });

    Ok(())
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
#[instruction(nonce: [u8; 32])]
pub struct VerifyProofCompact<'info> {
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

/// Decode a u16 from a 32-byte big-endian field element. Enforces that the
/// high 30 bytes are zero, preventing an attacker from passing a large field
/// element whose low 2 bytes happen to fall in-bounds while the circuit
/// evaluates the full value. Public inputs are BN254 scalar-field elements
/// in big-endian layout per the SDK's serializer.
fn decode_u16_from_field_element(fe: &[u8; 32]) -> Result<u16> {
    for b in &fe[..30] {
        require!(*b == 0, VerifierError::InvalidPublicInputs);
    }
    Ok(u16::from_be_bytes([fe[30], fe[31]]))
}

fn validate_hamming_bounds(threshold: u16, min_distance: u16) -> Result<()> {
    require!(
        threshold <= MAX_THRESHOLD,
        VerifierError::InvalidPublicInputs
    );
    require!(
        min_distance >= MIN_DISTANCE_FLOOR,
        VerifierError::InvalidPublicInputs
    );
    require!(min_distance < threshold, VerifierError::InvalidPublicInputs);
    Ok(())
}

fn encode_u16_field_element(value: u16) -> [u8; 32] {
    let mut encoded = [0u8; 32];
    encoded[30..].copy_from_slice(&value.to_be_bytes());
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u16_field_encoding_round_trips() {
        for value in [0, 1, MIN_DISTANCE_FLOOR, MAX_THRESHOLD, u16::MAX] {
            let encoded = encode_u16_field_element(value);
            assert_eq!(decode_u16_from_field_element(&encoded).unwrap(), value);
            assert_eq!(encoded[..30], [0u8; 30]);
        }
    }

    #[test]
    fn hamming_bounds_accept_the_program_ceiling_and_floor() {
        assert!(validate_hamming_bounds(MAX_THRESHOLD, MIN_DISTANCE_FLOOR).is_ok());
    }

    #[test]
    fn hamming_bounds_reject_a_threshold_above_the_program_ceiling() {
        assert!(validate_hamming_bounds(MAX_THRESHOLD + 1, MIN_DISTANCE_FLOOR).is_err());
    }

    #[test]
    fn hamming_bounds_reject_a_minimum_below_the_program_floor() {
        assert!(validate_hamming_bounds(MAX_THRESHOLD, MIN_DISTANCE_FLOOR - 1).is_err());
    }

    #[test]
    fn hamming_bounds_reject_an_empty_acceptance_interval() {
        assert!(validate_hamming_bounds(MIN_DISTANCE_FLOOR, MIN_DISTANCE_FLOOR).is_err());
    }
}
