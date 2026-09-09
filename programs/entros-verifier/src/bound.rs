use crate::{errors::VerifierError, state::Challenge};
use anchor_lang::prelude::*;
#[cfg(feature = "request-bound-v1")]
use entros_proof_request::{read_counter, Action, GENERATION};
use entros_proof_request::{BoundVerificationResult, ANCHOR_ID};

#[cfg(feature = "request-bound-v1")]
mod key {
    include!(env!("ENTROS_BOUND_VERIFYING_KEY"));
}

#[derive(Accounts)]
#[instruction(nonce: [u8; 32])]
pub struct VerifyProofBound<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>,
    #[account(mut, seeds = [b"challenge", verifier.key().as_ref(), nonce.as_ref()], bump = challenge.bump, constraint = challenge.challenger == verifier.key())]
    pub challenge: Account<'info, Challenge>,
    #[account(init, payer = verifier, space = BoundVerificationResult::LEN, seeds = [b"verification_bound", verifier.key().as_ref(), nonce.as_ref()], bump)]
    pub verification_result: Account<'info, BoundVerificationResult>,
    /// CHECK: The owner, discriminator, layout and wallet relation are checked before hashing.
    #[account(seeds = [b"identity", verifier.key().as_ref()], bump, seeds::program = ANCHOR_ID, owner = ANCHOR_ID)]
    pub identity_state: UncheckedAccount<'info>,
    /// CHECK: The exact versioned layout and wallet relation are checked before hashing.
    #[account(seeds = [b"proof_request_state", verifier.key().as_ref()], bump, seeds::program = ANCHOR_ID, owner = ANCHOR_ID)]
    pub proof_request_state: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: [u8; 32])]
pub struct CloseBoundVerificationResult<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>,
    #[account(mut, close = verifier, seeds = [b"verification_bound", verifier.key().as_ref(), nonce.as_ref()], bump = verification_result.bump, constraint = verification_result.wallet == verifier.key())]
    pub verification_result: Account<'info, BoundVerificationResult>,
}

#[allow(clippy::too_many_arguments)]
pub fn verify(
    ctx: Context<VerifyProofBound>,
    nonce: [u8; 32],
    proof: [u8; 256],
    new: [u8; 32],
    prev: [u8; 32],
    threshold: u16,
    min_distance: u16,
    valid_until: u64,
) -> Result<()> {
    require!(
        cfg!(feature = "request-bound-v1"),
        VerifierError::UnsupportedProofGeneration
    );
    #[cfg(not(feature = "request-bound-v1"))]
    {
        let _ = (
            ctx,
            nonce,
            proof,
            new,
            prev,
            threshold,
            min_distance,
            valid_until,
        );
        Ok(())
    }
    #[cfg(feature = "request-bound-v1")]
    {
        use entros_proof_request::{
            digest_limbs, request_digest, DEPLOYMENT_DOMAIN, MAX_REQUEST_LIFETIME,
        };
        use groth16_solana::groth16::Groth16Verifier;
        let now = Clock::get()?.unix_timestamp;
        let now_u64 = u64::try_from(now).map_err(|_| VerifierError::ChallengeExpired)?;
        require!(
            !ctx.accounts.challenge.used,
            VerifierError::ChallengeAlreadyUsed
        );
        require!(
            now < ctx.accounts.challenge.expires_at
                && valid_until >= now_u64
                && valid_until > 0
                && valid_until
                    <= now_u64
                        .checked_add(MAX_REQUEST_LIFETIME)
                        .ok_or(VerifierError::ArithmeticOverflow)?
                && valid_until
                    <= u64::try_from(ctx.accounts.challenge.expires_at)
                        .map_err(|_| VerifierError::ChallengeExpired)?,
            VerifierError::ChallengeExpired
        );
        crate::validate_hamming_bounds(threshold, min_distance)?;
        require!(
            new != [0; 32] && prev != [0; 32],
            VerifierError::InvalidPublicInputs
        );
        let wallet = ctx.accounts.verifier.key();
        let identity = ctx.accounts.identity_state.try_borrow_data()?;
        let discriminator = entros_proof_request::account_hash(b"account:IdentityState");
        require!(
            identity.len() == 593
                && identity[..8] == discriminator[..8]
                && identity[8..40] == wallet.to_bytes()
                && identity[62..94] == prev
                && identity[126] == ctx.bumps.identity_state,
            VerifierError::InvalidRequestContext
        );
        let mint = Pubkey::new_from_array(
            identity[94..126]
                .try_into()
                .map_err(|_| VerifierError::InvalidRequestContext)?,
        );
        require!(
            mint == Pubkey::find_program_address(&[b"mint", wallet.as_ref()], &ANCHOR_ID).0,
            VerifierError::InvalidRequestContext
        );
        let projection = u16::from_le_bytes(
            identity[583..585]
                .try_into()
                .map_err(|_| VerifierError::InvalidRequestContext)?,
        );
        let counter = read_counter(
            &ctx.accounts.proof_request_state.try_borrow_data()?,
            wallet,
            ctx.bumps.proof_request_state,
        )
        .ok_or(VerifierError::InvalidRequestContext)?;
        let action = Action {
            identity: ctx.accounts.identity_state.key(),
            mint,
            counter,
            projection,
            commitment_new: new,
            commitment_prev: prev,
            threshold,
            min_distance,
            valid_until,
        };
        let digest = request_digest(
            DEPLOYMENT_DOMAIN,
            crate::ID,
            ANCHOR_ID,
            wallet,
            nonce,
            &action,
        )
        .ok_or(VerifierError::InvalidPublicInputs)?;
        let limbs = digest_limbs(digest);
        let inputs = [
            new,
            prev,
            crate::encode_u16_field_element(threshold),
            crate::encode_u16_field_element(min_distance),
            limbs[0],
            limbs[1],
        ];
        let a: [u8; 64] = proof[..64]
            .try_into()
            .map_err(|_| VerifierError::InvalidProofFormat)?;
        let b: [u8; 128] = proof[64..192]
            .try_into()
            .map_err(|_| VerifierError::InvalidProofFormat)?;
        let c: [u8; 64] = proof[192..]
            .try_into()
            .map_err(|_| VerifierError::InvalidProofFormat)?;
        Groth16Verifier::new(&a, &b, &c, &inputs, &key::VERIFYINGKEY)
            .map_err(|_| VerifierError::ProofVerificationFailed)?
            .verify()
            .map_err(|_| VerifierError::ProofVerificationFailed)?;
        let result = &mut ctx.accounts.verification_result;
        result.set_inner(BoundVerificationResult {
            version: GENERATION,
            wallet,
            nonce,
            commitment_new: new,
            commitment_prev: prev,
            threshold,
            min_distance,
            counter,
            valid_until,
            verified_at: now,
            request_digest: digest,
            bump: ctx.bumps.verification_result,
        });
        ctx.accounts.challenge.used = true;
        Ok(())
    }
}
