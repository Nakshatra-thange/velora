// pub mod constants;
// pub mod error;
// pub mod instructions;
// pub mod state;

use anchor_lang::prelude::*;

// pub use constants::*;
// pub use instructions::*;
// pub use state::*;

declare_id!("EHHMy74EyjT2rAhMVMHEBm1N3TG349pJ4xstPX9uKjLV");

#[program]
pub mod velora {
    use super::*;

    pub fn register_operator(ctx: Context<RegisterOperator>, fee_bps:u16) -> Result<()> {
        require!(fee_bps < 10_000 , FacilitatorError::FeeTooHigh);
        let registry = &mut ctx.accounts.operator_registry;
        registry.operator   = ctx.accounts.operator.key();
        registry.fee_bps    = fee_bps;
        registry.is_active  = true;
        registry.registered_at = Clock::get()?.unix_timestamp;
        registry.bump          = ctx.bumps.operator_registry;

        let vault = &mut ctx.accounts.escrow_vault;
        vault.operator            = ctx.accounts.operator.key();
        vault.deposited_lamports  = 0;
        vault.locked_until        = 0;
        vault.bump                = ctx.bumps.escrow_vault;

        Ok(())
    }
}

#[account]
pub struct OperatorRegistry {
    pub operator:      Pubkey, // 32
    pub fee_bps:       u16,    // 2  — basis points, e.g. 50 = 0.5%
    pub is_active:     bool,   // 1
    pub registered_at: i64,    // 8  — unix timestamp
    pub bump:          u8,     // 1  — PDA canonical bump
}
 
#[account]
pub struct EscrowVault {
    pub operator:           Pubkey, // 32
    pub deposited_lamports: u64,    // 8
    pub locked_until:       i64,    // 8  — used in week 2 for slash timelock
    pub bump:               u8,     // 1
}
