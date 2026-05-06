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
        require!(fee_bps < 10_000 , VeloraError::FeeTooHigh);
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


#[derive(Accounts)]
pub struct RegisterOperator<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        init,
        payer  = operator,
        space  = 8 + 32 + 2 + 1 + 8 + 1,
        seeds  = [b"operator", operator.key().as_ref()],
        bump
    )]
    pub operator_registry: Account<'info, OperatorRegistry>,

    #[account(
        init,
        payer  = operator,
        space  = 8 + 32 + 8 + 8 + 1,
        seeds  = [b"escrow", operator.key().as_ref()],
        bump
    )]
    pub escrow_vault: Account<'info, EscrowVault>,
 
    pub system_program: Program<'info, System>,
}

#[account]
pub struct OperatorRegistry {
    pub operator:      Pubkey, 
    pub fee_bps:       u16,    
    pub is_active:     bool,  
    pub registered_at: i64,    
    pub bump:          u8,     
}
 
#[account]
pub struct EscrowVault {
    pub operator:           Pubkey, 
    pub deposited_lamports: u64,    
    pub locked_until:       i64,    
    pub bump:               u8,     
}

#[error_code]
pub enum VeloraError {
    #[msg("Fee basis points must be less than 10000 (100%)")]
    FeeTooHigh,
 
    #[msg("Operator already registered")]
    AlreadyRegistered,
 
    #[msg("Insufficient bond deposited")]
    InsufficientBond,
 
    #[msg("Slash condition not met")]
    SlashConditionNotMet,
}
