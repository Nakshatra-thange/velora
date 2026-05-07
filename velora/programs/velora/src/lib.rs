use anchor_lang::system_program;

use anchor_lang::prelude::*;

declare_id!("EHHMy74EyjT2rAhMVMHEBm1N3TG349pJ4xstPX9uKjLV");
pub const SCALE: u64 = 1_000_000;
pub const EMA_ALPHA: u64 = 950_000; //history
pub const EMA_BETA:  u64 =  50_000; //new 
pub const SLASH_THRESHOLD: u64 = 700_000; //threshold
pub const SLASH_BPS: u64 = 2_000; //basis pt
pub const MIN_BOND_LAMPORTS: u64 = 1_000_000_000; //min bond lamports
pub const MAX_ACCEPTABLE_LATENCY_MS: u32 = 2_000; 

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

    // Move SOL from operator wallet into escrow vault, then track the deposited amount.
    pub fn deposit_bond(ctx : Context<DepositBond>, amount_lamports : u64)-> Result<()>{
        require!(amount_lamports > 0, VeloraError::ZeroDeposit);
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from : ctx.accounts.operator.to_account_info(),
                to   : ctx.accounts.escrow_vault.to_account_info(),
            }
        );

        system_program::transfer(cpi_ctx, amount_lamports)?;

        let vault = &mut ctx.accounts.escrow_vault;
        vault.deposited_lamports = vault
                .deposited_lamports
                .checked_add(amount_lamports)
                .ok_or(VeloraError::MathOverflow)?;

        Ok(())
    }

    pub fn deregister_operator(ctx: Context<DeregisterOperator>) -> Result<()>{
        let return_amount = ctx.accounts.escrow_vault.deposited_lamports;
        require!(return_amount > 0, VeloraError::NoBondDeposited);

        **ctx.accounts.escrow_vault.to_account_info().try_borrow_mut_lamports()? -= return_amount;
        **ctx.accounts.operator.to_account_info().try_borrow_mut_lamports()?     += return_amount;

        ctx.accounts.escrow_vault.deposited_lamports = 0;
        ctx.accounts.operator_registry.is_active = false;

        Ok(())
    }
    pub fn initialize_scorecard(ctx: Context<InitializeScoreCard>) -> Result<()> {

        require!(
            ctx.accounts.operator_registry.is_active,
            VeloraError::InactiveOperator
        );
 
        require!(
            ctx.accounts.escrow_vault.deposited_lamports >= MIN_BOND_LAMPORTS,
            VeloraError::InsufficientBond
        );
 
        let score_card = &mut ctx.accounts.score_card;
        score_card.operator          = ctx.accounts.operator.key();
        score_card.ema_reliability   = SCALE; // starts at 1_000_000 = 100%
        score_card.total_volume      = 0;
        score_card.fulfillment_count = 0;
        score_card.slash_count       = 0;
        score_card.last_updated      = Clock::get()?.unix_timestamp;
        score_card.bump              = ctx.bumps.score_card;
 
        Ok(())
    }

    pub fn submit_proof(ctx: Context<SubmitProof>, proof:FulfillmentProof)->Result<()>{
        require!(
            ctx.accounts.operator_registry.is_active,
            VeloraError::InactiveOperator
        );

        require!(
            ctx.accounts.escrow_vault.deposited_lamports >= MIN_BOND_LAMPORTS,
            VeloraError::InsufficientBond
        );
 
        require!(
            proof.operator == ctx.accounts.operator.key(),
            VeloraError::UnauthorizedOperator
        );

        


    }
   
 
    // ── Week 2 / Day 3 placeholder ─────────────
    // submit_proof goes here
 
    // ── Week 2 / Day 4 placeholder ─────────────
    // slash_operator goes here
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

#[derive(Accounts)]
pub struct DepositBond<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        mut,
        seeds  = [b"escrow", operator.key().as_ref()],
        bump   = escrow_vault.bump,
        has_one = operator @ VeloraError::UnauthorizedOperator,
    )]
    pub escrow_vault: Account<'info, EscrowVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeregisterOperator<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
 
    #[account(
        mut,
        seeds  = [b"operator", operator.key().as_ref()],
        bump   = operator_registry.bump,
        has_one = operator @ VeloraError::UnauthorizedOperator,
    )]
    pub operator_registry: Account<'info, OperatorRegistry>,
 
    #[account(
        mut,
        seeds  = [b"escrow", operator.key().as_ref()],
        bump   = escrow_vault.bump,
        has_one = operator @ VeloraError::UnauthorizedOperator,
    )]
    pub escrow_vault: Account<'info, EscrowVault>,

}
 
#[derive(Accounts)]
pub struct InitializeScoreCard<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
 
    // read-only — we only check is_active, no mutation
    #[account(
        seeds   = [b"operator", operator.key().as_ref()],
        bump    = operator_registry.bump,
        has_one = operator @ VeloraError::UnauthorizedOperator,
    )]
    pub operator_registry: Account<'info, OperatorRegistry>,
 
    // read-only — we only check deposited_lamports
    #[account(
        seeds   = [b"escrow", operator.key().as_ref()],
        bump    = escrow_vault.bump,
        has_one = operator @ VeloraError::UnauthorizedOperator,
    )]
    pub escrow_vault: Account<'info, EscrowVault>,
 
    // space: 8 + 32 + 8 + 8 + 8 + 1 + 8 + 1 = 74 + 8 discriminator = 82
    #[account(
        init,
        payer  = operator,
        space  = 8 + 32 + 8 + 8 + 8 + 1 + 8 + 1,
        seeds  = [b"score", operator.key().as_ref()],
        bump
    )]
    pub score_card: Account<'info, ScoreCard>,
 
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

#[account]
pub struct ScoreCard {
    pub operator:          Pubkey, 
    pub ema_reliability:   u64,    
    pub total_volume:      u64,   
    pub fulfillment_count: u64,    
    pub slash_count:       u8,     
    pub last_updated:      i64,    
    pub bump:              u8,     
}        

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FulfillmentProof {
    pub amount:     u64,    
    pub latency_ms: u32,    
    pub merchant:   Pubkey, 
    pub operator:   Pubkey, 
}   

pub fn compute_fulfillment_score(latency_ms: u32) -> u64 {
    let latency = latency_ms as u64;
    let max     = MAX_ACCEPTABLE_LATENCY_MS as u64;
    let denom   = 2 * max; // 4_000
 
    if latency >= denom {
        return 0; // so slow it scores zero
    }
 
    // SCALE - (SCALE * latency / denom)
    // safe: latency < denom so (SCALE * latency / denom) < SCALE
    SCALE - (SCALE * latency / denom)
}
 
pub fn update_ema(old_ema: u64, new_score: u64) -> Result<u64> {
    let weighted_old   = EMA_ALPHA.checked_mul(old_ema).ok_or(VeloraError::MathOverflow)?;
    let weighted_new   = EMA_BETA.checked_mul(new_score).ok_or(VeloraError::MathOverflow)?;
    let numerator      = weighted_old.checked_add(weighted_new).ok_or(VeloraError::MathOverflow)?;
    let new_ema        = numerator.checked_div(SCALE).ok_or(VeloraError::MathOverflow)?;
    Ok(new_ema)
}

#[error_code]
pub enum VeloraError {
    #[msg("Fee basis points must be less than 10000 (100%)")]
    FeeTooHigh,
 
    #[msg("Operator already registered")]
    AlreadyRegistered,

    #[msg("No bond deposited — nothing to return")]
    NoBondDeposited,
 
    #[msg("Signer is not the operator of this account")]
    UnauthorizedOperator,
 
    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Insufficient bond deposited")]
    InsufficientBond,
 
    #[msg("Slash condition not met")]
    SlashConditionNotMet,

    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,

    #[msg("Operator is not active — register first")]
    InactiveOperator,

    #[msg("Operator has already been slashed and deactivated")]
    AlreadySlashed,

    #[msg("Merchant co-signature verification failed")]
    InvalidMerchantSignature,
 
   
}
