#![deny(clippy::all)]

use anchor_lang::prelude::*;
use solana_security_txt::security_txt;

mod errors;
mod groth16_verifier;
#[cfg(test)]
mod mock_verifier;
mod state;
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

/// Upper bound on the Hamming threshold an attacker can submit as a public input.
/// 96 / 256 bits matches the SDK's `DEFAULT_THRESHOLD` (pulse-sdk/src/config.ts).
/// Proofs asserting a larger allowed-drift window are rejected before they can
/// produce a VerificationResult.
const MAX_THRESHOLD: u16 = 96;

/// Lower bound on the Hamming min_distance an attacker can submit as a public input.
/// 3 / 256 bits matches the SDK's `DEFAULT_MIN_DISTANCE`. Proofs asserting a
/// smaller min_distance would pass Hamming=0 (exact replay), defeating the
/// circuit's anti-replay intent.
const MIN_DISTANCE_FLOOR: u16 = 3;

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

        // Validate public inputs BEFORE running the expensive Groth16 check.
        // The circuit has 4 public inputs in order:
        //   [0] commitment_new, [1] commitment_prev, [2] threshold, [3] min_distance
        // Each is a 32-byte big-endian field element. An attacker controls these
        // values, so we bound the circuit parameters here to prevent malicious
        // thresholds that would defeat the anti-replay and distance properties.
        require!(public_inputs.len() == 4, VerifierError::InvalidPublicInputs);
        require!(public_inputs[0] != [0u8; 32], VerifierError::InvalidPublicInputs);
        require!(public_inputs[1] != [0u8; 32], VerifierError::InvalidPublicInputs);
        let threshold = decode_u16_from_field_element(&public_inputs[2])?;
        let min_distance = decode_u16_from_field_element(&public_inputs[3])?;
        require!(threshold <= MAX_THRESHOLD, VerifierError::InvalidPublicInputs);
        require!(min_distance >= MIN_DISTANCE_FLOOR, VerifierError::InvalidPublicInputs);

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

        // Store verification result (only reached for valid proofs).
        // Commitments + bounded circuit parameters are persisted so that
        // entros-anchor::update_anchor can cross-program read them and enforce
        // that (a) commitment_new matches the submitted new_commitment and
        // (b) commitment_prev matches the identity's stored current_commitment.
        let result = &mut ctx.accounts.verification_result;
        result.verifier = ctx.accounts.verifier.key();
        result.proof_hash = proof_hash;
        result.verified_at = now;
        result.is_valid = true;
        result.challenge_nonce = nonce;
        result.bump = ctx.bumps.verification_result;
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
