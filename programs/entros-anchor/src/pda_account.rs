use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::EntrosAnchorError;

/// Creates a program-derived account at an address that may already hold lamports.
///
/// A derived address can hold lamports before its account exists, and the
/// System Program's `CreateAccount` refuses an address with a balance. This
/// path accepts both states: it tops the balance up to `rent_floor`, then
/// allocates and assigns with the address's own seeds. A surplus stays in the
/// account.
///
/// `rent_floor` can exceed the rent for `space` when a later instruction grows
/// the account and expects the rent to be there already.
pub fn create_pda_account<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    owner: &Pubkey,
    space: usize,
    rent_floor: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    require!(
        account.owner == &system_program::ID && account.data_is_empty(),
        EntrosAnchorError::DerivedAccountInUse
    );

    let shortfall = rent_floor.saturating_sub(account.lamports());
    if shortfall > 0 {
        system_program::transfer(
            CpiContext::new(
                system.key(),
                system_program::Transfer {
                    from: payer.clone(),
                    to: account.clone(),
                },
            ),
            shortfall,
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
        space as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            system.key(),
            system_program::Assign {
                account_to_assign: account.clone(),
            },
            &[seeds],
        ),
        owner,
    )
}
