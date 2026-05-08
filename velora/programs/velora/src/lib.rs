use anchor_lang::system_program;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    sysvar::instructions,
};


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
        let ix_sysvar = &ctx.accounts.instructions_sysvar;
        let ed25519_ix = instructions::load_instruction_at_checked(
            instructions::load_current_index_checked(
                &ix_sysvar.to_account_info()
            )? as usize - 1,  // the preceding instruction
            &ix_sysvar.to_account_info(),
        ).map_err(|_| VeloraError::InvalidMerchantSignature)?;

        require!(
            ed25519_ix.program_id.to_string()
    == "Ed25519SigVerify111111111111111111111111111",
            VeloraError::InvalidMerchantSignature
        );

        let data = &ed25519_ix.data;
        require!(data.len() >= 1 + 14 + 64 + 32, VeloraError::InvalidMerchantSignature);

        let pubkey_offset = 1 + 14 + 64;
        let pubkey_bytes: [u8; 32] = data[pubkey_offset..pubkey_offset + 32]
            .try_into()
            .map_err(|_| VeloraError::InvalidMerchantSignature)?;
        let recovered_pubkey = Pubkey::from(pubkey_bytes);

        let message_offset = pubkey_offset + 32;
        let signed_message  = &data[message_offset..];

        // reconstruct the expected message: borsh(proof)
        let expected_message = proof.try_to_vec()
            .map_err(|_| VeloraError::InvalidMerchantSignature)?;

        require!(
            recovered_pubkey  == proof.merchant,
            VeloraError::InvalidMerchantSignature
        );
        require!(
            signed_message == expected_message.as_slice(),
            VeloraError::InvalidMerchantSignature
        );
    
    let this_score = compute_fulfillment_score(proof.latency_ms);
    let score_card = &mut ctx.accounts.score_card;

    score_card.ema_reliability = update_ema(score_card.ema_reliability, this_score)?;

    score_card.total_volume = score_card
        .total_volume
        .checked_add(proof.amount)
        .ok_or(VeloraError::MathOverflow)?;

    score_card.fulfillment_count = score_card
        .fulfillment_count
        .checked_add(1)
        .ok_or(VeloraError::MathOverflow)?;

    score_card.last_updated = Clock::get()?.unix_timestamp;
    emit!(ProofSubmitted {
        operator:        ctx.accounts.operator.key(),
        merchant:        proof.merchant,
        amount:          proof.amount,
        latency_ms:      proof.latency_ms,
        this_score,
        new_ema:         score_card.ema_reliability,
        fulfillment_count: score_card.fulfillment_count,
    });

    Ok(())

}

  pub fn slash_operator(ctx:Context<SlashOperator>)->Result<()>{
    require!(
        ctx.accounts.operator_registry.is_active,
        VeloraError::AlreadySlashed
    );

    require!(
        ctx.accounts.score_card.ema_reliability < SLASH_THRESHOLD,
        VeloraError::SlashConditionNotMet
    );

    let bond            = ctx.accounts.escrow_vault.deposited_lamports;
    let slash_amount    = bond
        .checked_mul(SLASH_BPS)
        .ok_or(VeloraError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(VeloraError::MathOverflow)?;

    require!(slash_amount > 0, VeloraError::InsufficientBond);
    **ctx.accounts.escrow_vault.to_account_info().try_borrow_mut_lamports()? -= slash_amount;
    **ctx.accounts.cranker.to_account_info().try_borrow_mut_lamports()?      += slash_amount;

    // update tracked balance
    ctx.accounts.escrow_vault.deposited_lamports = bond
    .checked_sub(slash_amount)
    .ok_or(VeloraError::MathOverflow)?;

// ── increment slash_count on scorecard ──
ctx.accounts.score_card.slash_count = ctx.accounts.score_card
    .slash_count
    .checked_add(1)
    .unwrap_or(u8::MAX); // saturate at 255, don't overflow

// ── deactivate operator ──
ctx.accounts.operator_registry.is_active = false;

// ── emit event ──
emit!(OperatorSlashed {
    operator:     ctx.accounts.operator_registry.operator,
    cranker:      ctx.accounts.cranker.key(),
    slash_amount,
    bond_remaining: ctx.accounts.escrow_vault.deposited_lamports,
    slash_count:  ctx.accounts.score_card.slash_count,
    ema_at_slash: ctx.accounts.score_card.ema_reliability,
});

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
#[derive(Accounts)]
pub struct SubmitProof<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
 
    // read-only — only checking is_active
    #[account(
        seeds   = [b"operator", operator.key().as_ref()],
        bump    = operator_registry.bump,
        has_one = operator @ VeloraError::UnauthorizedOperator,
    )]
    pub operator_registry: Account<'info, OperatorRegistry>,
 
    #[account(
        mut,
        seeds   = [b"score", operator.key().as_ref()],
        bump    = score_card.bump,
        has_one = operator @ VeloraError::UnauthorizedOperator,
    )]
    pub score_card: Account<'info, ScoreCard>,
 
    // read-only — only checking deposited_lamports >= MIN_BOND
    #[account(
        seeds   = [b"escrow", operator.key().as_ref()],
        bump    = escrow_vault.bump,
        has_one = operator @ VeloraError::UnauthorizedOperator,
    )]
    pub escrow_vault: Account<'info, EscrowVault>,

    /// CHECK: This is the Solana instructions sysvar used for
/// ed25519 instruction introspection. Address is verified in constraints.
#[account(address = instructions::ID)]
pub instructions_sysvar: AccountInfo<'info>,
}
 
#[derive(Accounts)]
pub struct SlashOperator<'info> {
    /// Anyone can be the cranker — fully permissionless
    #[account(mut)]
    pub cranker: Signer<'info>,
 
    #[account(
        mut,
        seeds  = [b"operator", operator_registry.operator.as_ref()],
        bump   = operator_registry.bump,
    )]
    pub operator_registry: Account<'info, OperatorRegistry>,
 
    // read-only — we only read ema_reliability to check slash condition
    #[account(
        mut,
        seeds  = [b"score", operator_registry.operator.as_ref()],
        bump   = score_card.bump,
    )]
    pub score_card: Account<'info, ScoreCard>,
 
    #[account(
        mut,
        seeds  = [b"escrow", operator_registry.operator.as_ref()],
        bump   = escrow_vault.bump,
    )]
    pub escrow_vault: Account<'info, EscrowVault>,
}

#[event]
pub struct ProofSubmitted {
    pub operator:          Pubkey,
    pub merchant:          Pubkey,
    pub amount:            u64,
    pub latency_ms:        u32,
    pub this_score:        u64,  // score for this single fulfillment
    pub new_ema:           u64,  // updated EMA after this proof
    pub fulfillment_count: u64,
}
 
#[event]
pub struct OperatorSlashed {
    pub operator:       Pubkey,
    pub cranker:        Pubkey,
    pub slash_amount:   u64,
    pub bond_remaining: u64,
    pub slash_count:    u8,
    pub ema_at_slash:   u64,
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
