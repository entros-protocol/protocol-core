use crate::errors::EntrosAnchorError;
use anchor_lang::prelude::*;
#[cfg(feature = "request-bound-v1")]
use anchor_lang::system_program;
#[cfg(feature = "request-bound-v1")]
use entros_proof_request::read_counter;
use entros_proof_request::{GENERATION, STATE_LEN};

#[account]
pub struct ProofRequestState {
    pub version: u8,
    pub wallet: Pubkey,
    pub counter: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct PrepareProofRequest<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init_if_needed, payer = authority, space = STATE_LEN, seeds = [b"proof_request_state", authority.key().as_ref()], bump)]
    pub proof_request_state: Account<'info, ProofRequestState>,
    pub system_program: Program<'info, System>,
}

pub fn prepare(ctx: Context<PrepareProofRequest>) -> Result<()> {
    require!(
        cfg!(feature = "request-bound-v1"),
        EntrosAnchorError::UnsupportedProofGeneration
    );
    let state = &mut ctx.accounts.proof_request_state;
    if state.version == 0 {
        require!(
            state.wallet == Pubkey::default() && state.counter == 0,
            EntrosAnchorError::InvalidRequestContext
        );
        state.version = GENERATION;
        state.wallet = ctx.accounts.authority.key();
        state.bump = ctx.bumps.proof_request_state;
    }
    require!(
        state.version == GENERATION
            && state.wallet == ctx.accounts.authority.key()
            && state.bump == ctx.bumps.proof_request_state,
        EntrosAnchorError::InvalidRequestContext
    );
    Ok(())
}

#[cfg(feature = "request-bound-v1")]
pub fn advance<'info>(
    account: &AccountInfo<'info>,
    wallet: Pubkey,
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
) -> Result<()> {
    require!(
        account.is_writable && payer.is_signer,
        EntrosAnchorError::InvalidRequestContext
    );
    let (key, bump) =
        Pubkey::find_program_address(&[b"proof_request_state", wallet.as_ref()], &crate::ID);
    require_keys_eq!(*account.key, key, EntrosAnchorError::InvalidRequestContext);
    if account.owner == &system_program::ID && account.data_is_empty() {
        let seeds: &[&[u8]] = &[b"proof_request_state", wallet.as_ref(), &[bump]];
        let required = Rent::get()?.minimum_balance(STATE_LEN);
        if account.lamports() < required {
            system_program::transfer(
                CpiContext::new(
                    system.key(),
                    system_program::Transfer {
                        from: payer.clone(),
                        to: account.clone(),
                    },
                ),
                required - account.lamports(),
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(
                system.key(),
                system_program::Allocate {
                    account_to_allocate: account.clone(),
                },
                &[seeds],
            ),
            STATE_LEN as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(
                system.key(),
                system_program::Assign {
                    account_to_assign: account.clone(),
                },
                &[seeds],
            ),
            &crate::ID,
        )?;
        ProofRequestState {
            version: GENERATION,
            wallet,
            counter: 0,
            bump,
        }
        .try_serialize(&mut &mut account.try_borrow_mut_data()?[..])?;
    }
    require_keys_eq!(
        *account.owner,
        crate::ID,
        EntrosAnchorError::InvalidRequestContext
    );
    let counter = read_counter(&account.try_borrow_data()?, wallet, bump)
        .ok_or(EntrosAnchorError::InvalidRequestContext)?;
    let next = counter
        .checked_add(1)
        .ok_or(EntrosAnchorError::ArithmeticOverflow)?;
    account.try_borrow_mut_data()?[41..49].copy_from_slice(&next.to_le_bytes());
    Ok(())
}

#[derive(Accounts)]
pub struct UpgradeIdentityLayout<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: The authenticated wallet and exact known layout are validated before resizing.
    #[account(mut, seeds = [b"identity", authority.key().as_ref()], bump, owner = crate::ID)]
    pub identity_state: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn upgrade_identity_layout(ctx: Context<UpgradeIdentityLayout>) -> Result<()> {
    require!(
        cfg!(feature = "request-bound-v1"),
        EntrosAnchorError::UnsupportedProofGeneration
    );
    let account = &ctx.accounts.identity_state;
    let old_len = account.data_len();
    require!(
        matches!(old_len, 543 | 551 | 583 | 593),
        EntrosAnchorError::InvalidIdentityState
    );
    let wallet = ctx.accounts.authority.key();
    {
        let data = account.try_borrow_data()?;
        let discriminator = entros_proof_request::account_hash(b"account:IdentityState");
        require!(
            data[..8] == discriminator[..8]
                && data[8..40] == wallet.to_bytes()
                && data[126] == ctx.bumps.identity_state,
            EntrosAnchorError::InvalidIdentityState
        );
        let expected_mint = Pubkey::find_program_address(&[b"mint", wallet.as_ref()], &crate::ID).0;
        require!(
            data[94..126] == expected_mint.to_bytes(),
            EntrosAnchorError::InvalidIdentityState
        );
    }
    if old_len == crate::IdentityState::LEN {
        return Ok(());
    }
    let required = Rent::get()?.minimum_balance(crate::IdentityState::LEN);
    if account.lamports() < required {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: account.to_account_info(),
                },
            ),
            required - account.lamports(),
        )?;
    }
    account.resize(crate::IdentityState::LEN)?;
    account.try_borrow_mut_data()?[old_len..].fill(0);
    Ok(())
}
