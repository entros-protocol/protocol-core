#![deny(clippy::all)]

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022;
use anchor_spl::token_interface::TokenInterface;
use solana_security_txt::security_txt;

mod errors;
mod state;

use errors::IamAnchorError;
use state::IdentityState;

declare_id!("GZYwTp2ozeuRA5Gof9vs4ya961aANcJBdUzB7LN6q4b2");

security_txt! {
    name: "IAM Anchor",
    project_url: "https://iamprotocol.io",
    contacts: "email:contact@iamprotocol.io",
    policy: "https://iamprotocol.io/security",
    source_code: "https://github.com/iam-protocol/protocol-core"
}

/// iam-registry program ID for cross-program ProtocolConfig PDA validation.
/// Decoded from: 6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW
const REGISTRY_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    81, 130, 250, 230, 30, 253, 246, 69, 82, 96, 7, 173, 78, 160, 131, 188, 70, 106, 173, 59,
    102, 163, 198, 189, 82, 37, 225, 38, 52, 233, 157, 117,
]);

/// iam-verifier program ID for cross-program VerificationResult PDA validation.
/// Decoded from: 4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV
const VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    48, 50, 94, 115, 90, 162, 108, 8, 240, 151, 76, 223, 101, 176, 170, 86, 254, 247, 252, 28,
    240, 145, 60, 108, 42, 129, 105, 32, 232, 212, 226, 52,
]);

/// Maximum age of a VerificationResult consumed by update_anchor, in seconds.
/// Bounds the verify-to-consume window separately from challenge_expiry
/// (which bounds proof-generation-to-verification). 600s = 10 min accommodates
/// relayer latency without allowing stale proofs to sit indefinitely.
const MAX_PROOF_AGE_SECS: i64 = 600;

/// Post-patch size of the iam-verifier `VerificationResult` account.
/// Enforced as a length check in update_anchor — accounts created before the
/// 2026-04-20 binding patch have the smaller legacy layout (114 bytes) and
/// are rejected with `StaleVerificationResult`. Keep in sync with
/// `iam_verifier::state::VerificationResult::LEN`.
const VERIFICATION_RESULT_LEN_V2: usize = 182;

/// Anchor discriminator for `VerificationResult` (first 8 bytes of
/// `sha256("account:VerificationResult")`). Defense-in-depth check that the
/// referenced account is actually an iam-verifier VerificationResult and not
/// a same-length account owned by iam-verifier that happens to resolve at
/// the PDA seeds.
const VERIFICATION_RESULT_DISCRIMINATOR: [u8; 8] = [104, 111, 80, 172, 219, 191, 162, 38];

/// Byte offsets into the packed VerificationResult account data (post-patch).
/// After the 8-byte Anchor discriminator, fields are serialized in struct order.
/// Keep synchronized with iam-verifier/src/state.rs.
const VR_OFFSET_VERIFIER: usize = 8;
const VR_OFFSET_VERIFIED_AT: usize = 72;
const VR_OFFSET_COMMITMENT_NEW: usize = 114;
const VR_OFFSET_COMMITMENT_PREV: usize = 146;

/// Integer square root via Newton's method (deterministic, no floating point).
/// Mirrors iam_registry::isqrt — keep implementations in sync.
fn isqrt(n: u64) -> u64 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// Mint account space for Token-2022 with NonTransferable extension.
/// Base mint = 82 bytes, account type = 1 byte, extension type (2) + length (2) = 4 bytes,
/// NonTransferable data = 0 bytes. Plus multisig padding from Token-2022.
/// We use a constant derived from the Token-2022 spec.
const MINT_SIZE_WITH_NON_TRANSFERABLE: usize = 170;

#[program]
pub mod iam_anchor {
    use super::*;

    /// Mint a new IAM Anchor identity for the caller.
    /// Creates a NonTransferable Token-2022 mint, mints 1 token to the user's ATA,
    /// and initializes the IdentityState PDA.
    pub fn mint_anchor(ctx: Context<MintAnchor>, initial_commitment: [u8; 32]) -> Result<()> {
        require!(
            initial_commitment != [0u8; 32],
            IamAnchorError::InvalidCommitment
        );

        let user_key = ctx.accounts.user.key();
        let mint_seeds: &[&[u8]] = &[b"mint", user_key.as_ref(), &[ctx.bumps.mint]];
        let mint_authority_seeds: &[&[u8]] = &[b"mint_authority", &[ctx.bumps.mint_authority]];

        // 1. Allocate mint account with space for NonTransferable extension
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(MINT_SIZE_WITH_NON_TRANSFERABLE);

        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.mint.to_account_info(),
                },
                &[mint_seeds],
            ),
            lamports,
            MINT_SIZE_WITH_NON_TRANSFERABLE as u64,
            ctx.accounts.token_program.key,
        )?;

        // 2. Initialize NonTransferable extension (MUST be before InitializeMint2)
        let ix = spl_token_2022::instruction::initialize_non_transferable_mint(
            ctx.accounts.token_program.key,
            &ctx.accounts.mint.key(),
        )?;
        anchor_lang::solana_program::program::invoke(&ix, &[ctx.accounts.mint.to_account_info()])?;

        // 3. Initialize the mint (decimals=0, authority=mint_authority PDA)
        let ix = spl_token_2022::instruction::initialize_mint2(
            ctx.accounts.token_program.key,
            &ctx.accounts.mint.key(),
            &ctx.accounts.mint_authority.key(),
            None, // no freeze authority
            0,    // decimals
        )?;
        anchor_lang::solana_program::program::invoke(&ix, &[ctx.accounts.mint.to_account_info()])?;

        // 4. Create the user's Associated Token Account
        anchor_spl::associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            anchor_spl::associated_token::Create {
                payer: ctx.accounts.user.to_account_info(),
                associated_token: ctx.accounts.token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;

        // 5. Mint exactly 1 token to the user's ATA
        token_2022::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_2022::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.token_account.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[mint_authority_seeds],
            ),
            1,
        )?;

        // 6. Initialize IdentityState PDA
        let identity = &mut ctx.accounts.identity_state;
        let now = Clock::get()?.unix_timestamp;
        identity.owner = ctx.accounts.user.key();
        identity.creation_timestamp = now;
        identity.last_verification_timestamp = now;
        identity.verification_count = 0;
        identity.trust_score = 0;
        identity.current_commitment = initial_commitment;
        identity.mint = ctx.accounts.mint.key();
        identity.bump = ctx.bumps.identity_state;
        identity.recent_timestamps = [0i64; 52];

        // Read verification fee from protocol config (cross-program, iam-registry)
        let config_data = ctx.accounts.protocol_config.try_borrow_data()?;
        let verification_fee = if config_data.len() >= 69 {
            u64::from_le_bytes([
                config_data[61], config_data[62], config_data[63], config_data[64],
                config_data[65], config_data[66], config_data[67], config_data[68],
            ])
        } else {
            0
        };
        drop(config_data);

        // Transfer verification fee from user to protocol treasury
        if verification_fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.user.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                ),
                verification_fee,
            )?;
        }

        emit!(AnchorMinted {
            owner: identity.owner,
            mint: identity.mint,
            commitment: initial_commitment,
        });

        Ok(())
    }

    /// Update the identity state after a successful proof verification.
    ///
    /// Trust score is computed automatically from verification history and protocol config.
    /// Handles transparent migration from old (10-slot) to new (52-slot) account layouts.
    ///
    /// Requires a matching, fresh `VerificationResult` PDA (owned by iam-verifier)
    /// whose `commitment_new` equals `new_commitment` and whose `commitment_prev`
    /// equals the identity's current stored commitment. Without this binding the
    /// instruction would accept any commitment with no biometric proof — allowing
    /// trust-score farming via per-call fee payment, which contradicts the
    /// protocol's economic deterrence model. See AUDIT.md for details.
    ///
    /// The `verification_nonce` argument supplies the challenge nonce used to
    /// derive the VerificationResult PDA (`seeds = [b"verification", authority, nonce]`).
    /// Single-use is enforced implicitly: after this call, `current_commitment`
    /// rotates to `new_commitment`, so the consumed VerificationResult's
    /// `commitment_prev` no longer matches on any future call.
    #[allow(unused_variables)] // nonce is consumed via the #[instruction] seeds constraint
    pub fn update_anchor(
        ctx: Context<UpdateAnchor>,
        new_commitment: [u8; 32],
        verification_nonce: [u8; 32],
    ) -> Result<()> {
        require!(
            new_commitment != [0u8; 32],
            IamAnchorError::InvalidCommitment
        );

        let identity_info = &ctx.accounts.identity_state;
        // Defense-in-depth: the seeds constraint already forces the address,
        // but an explicit owner check prevents any future refactor from
        // accidentally accepting a program-external account at this PDA.
        require!(
            identity_info.owner == &crate::ID,
            IamAnchorError::InvalidIdentityState
        );
        let now = Clock::get()?.unix_timestamp;
        let new_len = IdentityState::LEN;

        // Migrate: resize old accounts (207 bytes / 10 slots) to new size (543 bytes / 52 slots)
        let current_len = identity_info.data_len();
        if current_len < new_len {
            identity_info.realloc(new_len, true)?;
            // Pay additional rent for the extra space
            let rent = Rent::get()?;
            let required = rent.minimum_balance(new_len);
            let current_lamports = identity_info.lamports();
            if required > current_lamports {
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        system_program::Transfer {
                            from: ctx.accounts.authority.to_account_info(),
                            to: identity_info.to_account_info(),
                        },
                    ),
                    required - current_lamports,
                )?;
            }
        }

        // Deserialize identity state (now guaranteed to be the right size)
        let mut identity = {
            let data = identity_info.try_borrow_data()?;
            IdentityState::try_deserialize(&mut &data[..])
                .map_err(|_| error!(IamAnchorError::InvalidIdentityState))?
        };

        // Verify ownership
        require!(
            identity.owner == ctx.accounts.authority.key(),
            IamAnchorError::Unauthorized
        );

        // Cross-program validation of the VerificationResult PDA.
        //
        // The account is passed as UncheckedAccount because Anchor's
        // `Account<T>` deserialization requires owner-program equality with the
        // crate that defined `T`; iam-verifier's state type isn't in scope for
        // iam-anchor and adding a CPI dependency just to deserialize is
        // heavier than raw-bytes validation. This matches the existing
        // cross-program read pattern used for ProtocolConfig below.
        //
        // The `seeds = [b"verification", authority, verification_nonce]` +
        // `seeds::program = VERIFIER_PROGRAM_ID` constraint on the account
        // context guarantees the PDA address is correct. Here we additionally
        // enforce: (a) owner program, (b) account is post-patch layout,
        // (c) verifier matches signing authority, (d) proof is fresh,
        // (e) commitment_new matches submitted new_commitment,
        // (f) commitment_prev matches identity's current_commitment.
        let vr_info = ctx.accounts.verification_result.to_account_info();
        require!(
            vr_info.owner == &VERIFIER_PROGRAM_ID,
            IamAnchorError::VerificationResultWrongOwner
        );
        let vr_data = vr_info.try_borrow_data()?;
        require!(
            vr_data.len() >= VERIFICATION_RESULT_LEN_V2,
            IamAnchorError::StaleVerificationResult
        );
        // Discriminator check: the first 8 bytes must match iam-verifier's
        // Anchor-computed `sha256("account:VerificationResult")[0..8]`.
        // Prevents a same-length but differently-typed account (e.g. some
        // future Challenge v2 or an orphaned account) from masquerading.
        require!(
            vr_data[0..8] == VERIFICATION_RESULT_DISCRIMINATOR,
            IamAnchorError::StaleVerificationResult
        );
        let verifier_pk_bytes: [u8; 32] = vr_data
            [VR_OFFSET_VERIFIER..VR_OFFSET_VERIFIER + 32]
            .try_into()
            .map_err(|_| error!(IamAnchorError::InvalidIdentityState))?;
        let verifier_pk = Pubkey::new_from_array(verifier_pk_bytes);
        require!(
            verifier_pk == ctx.accounts.authority.key(),
            IamAnchorError::VerifierMismatch
        );
        let verified_at_bytes: [u8; 8] = vr_data
            [VR_OFFSET_VERIFIED_AT..VR_OFFSET_VERIFIED_AT + 8]
            .try_into()
            .map_err(|_| error!(IamAnchorError::InvalidIdentityState))?;
        let verified_at = i64::from_le_bytes(verified_at_bytes);
        require!(
            now.saturating_sub(verified_at) <= MAX_PROOF_AGE_SECS,
            IamAnchorError::ProofExpired
        );
        let commitment_new_bound: [u8; 32] = vr_data
            [VR_OFFSET_COMMITMENT_NEW..VR_OFFSET_COMMITMENT_NEW + 32]
            .try_into()
            .map_err(|_| error!(IamAnchorError::InvalidIdentityState))?;
        let commitment_prev_bound: [u8; 32] = vr_data
            [VR_OFFSET_COMMITMENT_PREV..VR_OFFSET_COMMITMENT_PREV + 32]
            .try_into()
            .map_err(|_| error!(IamAnchorError::InvalidIdentityState))?;
        drop(vr_data);
        require!(
            commitment_new_bound == new_commitment,
            IamAnchorError::CommitmentMismatch
        );
        require!(
            commitment_prev_bound == identity.current_commitment,
            IamAnchorError::PrevCommitmentMismatch
        );

        identity.current_commitment = new_commitment;
        identity.verification_count = identity
            .verification_count
            .checked_add(1)
            .ok_or(IamAnchorError::ArithmeticOverflow)?;
        identity.last_verification_timestamp = now;

        // Shift recent_timestamps array: drop oldest, prepend newest
        for i in (1..52).rev() {
            identity.recent_timestamps[i] = identity.recent_timestamps[i - 1];
        }
        identity.recent_timestamps[0] = now;

        // Read protocol config (cross-program, iam-registry)
        // Layout: 8 disc + 32 admin + 8 min_stake + 8 challenge_expiry = offset 56
        let config_data = ctx.accounts.protocol_config.try_borrow_data()?;
        require!(
            config_data.len() >= 69,
            IamAnchorError::InvalidProtocolConfig
        );
        let max_trust_score = u16::from_le_bytes([config_data[56], config_data[57]]);
        let base_trust_increment = u16::from_le_bytes([config_data[58], config_data[59]]);
        let verification_fee = u64::from_le_bytes([
            config_data[61], config_data[62], config_data[63], config_data[64],
            config_data[65], config_data[66], config_data[67], config_data[68],
        ]);
        drop(config_data);

        // Deduplicate timestamps by calendar day (newest-first order means
        // same-day entries are adjacent). Multiple verifications on the same day
        // count once for scoring — consistency over time, not volume.
        let mut unique_ts = [0i64; 52];
        let mut unique_count: usize = 0;
        let mut prev_day: i64 = -1;
        for ts in identity.recent_timestamps.iter() {
            if *ts == 0 {
                continue;
            }
            let days_since = ((now - ts) / 86400).max(0);
            if days_since != prev_day {
                unique_ts[unique_count] = *ts;
                unique_count += 1;
                prev_day = days_since;
            }
        }

        // Recency-weighted score from unique verification days
        let mut recency_score: u64 = 0;
        for i in 0..unique_count {
            let days_since = ((now - unique_ts[i]) / 86400).max(0) as u64;
            recency_score += 3000 / (30 + days_since);
        }
        let base_score = (recency_score * u64::from(base_trust_increment)) / 100;

        // Regularity bonus from gap consistency (unique days only)
        let mut gaps = [0i64; 51];
        let mut gaps_len = 0usize;
        for i in 0..unique_count.saturating_sub(1) {
            gaps[gaps_len] = (unique_ts[i] - unique_ts[i + 1]) / 86400;
            gaps_len += 1;
        }
        let regularity_bonus: u64 = if gaps_len >= 2 {
            let gap_slice = &gaps[..gaps_len];
            let mean_gap: i64 = gap_slice.iter().sum::<i64>() / gaps_len as i64;
            let variance: u64 = gap_slice
                .iter()
                .map(|g| ((g - mean_gap) * (g - mean_gap)) as u64)
                .sum::<u64>()
                / gaps_len as u64;
            let stddev = isqrt(variance);
            20u64.saturating_sub(stddev.min(20))
        } else {
            0
        };

        // Age bonus with diminishing returns
        let age_seconds = now
            .checked_sub(identity.creation_timestamp)
            .ok_or(IamAnchorError::ArithmeticOverflow)?;
        let age_days: u64 = (age_seconds / 86400).try_into().unwrap_or(0);
        let age_bonus = isqrt(age_days.min(365)) * 2;

        let total = base_score
            .saturating_add(regularity_bonus)
            .saturating_add(age_bonus);
        identity.trust_score = total.min(u64::from(max_trust_score)) as u16;

        // Serialize identity state back to account
        let mut data = identity_info.try_borrow_mut_data()?;
        identity.try_serialize(&mut *data)
            .map_err(|_| error!(IamAnchorError::IdentitySerializationFailed))?;
        drop(data);

        // Transfer verification fee from user to protocol treasury
        if verification_fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                ),
                verification_fee,
            )?;
        }

        emit!(AnchorUpdated {
            owner: identity.owner,
            verification_count: identity.verification_count,
            trust_score: identity.trust_score,
            commitment: new_commitment,
        });

        Ok(())
    }
}

// --- Account Contexts ---

#[derive(Accounts)]
pub struct MintAnchor<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init,
        payer = user,
        space = IdentityState::LEN,
        seeds = [b"identity", user.key().as_ref()],
        bump,
    )]
    pub identity_state: Account<'info, IdentityState>,

    /// CHECK: Created manually via CPI to support Token-2022 NonTransferable extension
    /// initialization ordering. PDA seeds ensure uniqueness per user.
    #[account(
        mut,
        seeds = [b"mint", user.key().as_ref()],
        bump,
    )]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: PDA used as mint authority. No data stored.
    #[account(
        seeds = [b"mint_authority"],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: Created via associated_token CPI. Validated by the ATA program.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// CHECK: Cross-program read of iam-registry ProtocolConfig PDA.
    #[account(
        seeds = [b"protocol_config"],
        bump,
        seeds::program = REGISTRY_PROGRAM_ID,
    )]
    pub protocol_config: UncheckedAccount<'info>,

    /// CHECK: Protocol treasury PDA on iam-registry. Receives verification fees.
    #[account(
        mut,
        seeds = [b"protocol_treasury"],
        bump,
        seeds::program = REGISTRY_PROGRAM_ID,
    )]
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(new_commitment: [u8; 32], verification_nonce: [u8; 32])]
pub struct UpdateAnchor<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: IdentityState PDA. Uses raw byte access to handle transparent migration
    /// from old (10-slot) to new (52-slot) account layouts. PDA validated by seeds.
    /// Ownership verified in instruction body after deserialization.
    #[account(
        mut,
        seeds = [b"identity", authority.key().as_ref()],
        bump,
    )]
    pub identity_state: UncheckedAccount<'info>,

    /// CHECK: Cross-program read of iam-verifier VerificationResult PDA.
    /// PDA seeds validated by Anchor; layout + owner + cross-field constraints
    /// validated in instruction body. Binds the ZK proof to this specific
    /// update — without this account, update_anchor would accept any commitment
    /// with no proof.
    #[account(
        seeds = [b"verification", authority.key().as_ref(), verification_nonce.as_ref()],
        bump,
        seeds::program = VERIFIER_PROGRAM_ID,
    )]
    pub verification_result: UncheckedAccount<'info>,

    /// CHECK: Cross-program read of iam-registry ProtocolConfig PDA.
    /// Validated by seeds + owner via seeds::program.
    #[account(
        seeds = [b"protocol_config"],
        bump,
        seeds::program = REGISTRY_PROGRAM_ID,
    )]
    pub protocol_config: UncheckedAccount<'info>,

    /// CHECK: Protocol treasury PDA on iam-registry. Receives verification fees.
    #[account(
        mut,
        seeds = [b"protocol_treasury"],
        bump,
        seeds::program = REGISTRY_PROGRAM_ID,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// --- Events ---

#[event]
pub struct AnchorMinted {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub commitment: [u8; 32],
}

#[event]
pub struct AnchorUpdated {
    pub owner: Pubkey,
    pub verification_count: u32,
    pub trust_score: u16,
    pub commitment: [u8; 32],
}
