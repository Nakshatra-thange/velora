use anchor_lang::system_program;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    sysvar::instructions,
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};


declare_id!("EHHMy74EyjT2rAhMVMHEBm1N3TG349pJ4xstPX9uKjLV");
pub const SCALE: u64 = 1_000_000;
pub const EMA_ALPHA: u64 = 950_000; //history
pub const EMA_BETA:  u64 =  50_000; //new 
pub const SLASH_THRESHOLD: u64 = 700_000; //threshold
pub const SLASH_BPS: u64 = 2_000; //basis pt
pub const MIN_BOND_LAMPORTS: u64 = 1_000_000_000; //min bond lamports
pub const MAX_ACCEPTABLE_LATENCY_MS: u32 = 2_000; 
pub const EPOCH_SLOTS: u64 = 172_800;
pub const EPOCH_BUDGET: u64 = 1_000_000_000_000;
pub const TOKEN_DECIMALS: u8 = 6;
pub const MIN_PROOFS_FOR_EMISSION: u64 = 5;
pub const BASE_EMISSION_RATE: u64 = 100_000_000; 
pub const MINT_SEED: &[u8] = b"velora_mint";
pub const EPOCH_SEED: &[u8] = b"epoch";

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

pub fn initialize_mint(_ctx: Context<InitializeMint>)-> Result<()>{
    msg!("Velora mint ready.");
    Ok(())
}
pub fn initialize_epoch(
    ctx:Context<InitializeEpoch>, epoch_number: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let epoch = &mut ctx.accounts.epoch_state;
    epoch.epoch_number     = epoch_number;
    epoch.epoch_start_slot = clock.slot;
    epoch.epoch_budget     = EPOCH_BUDGET;
    epoch.epoch_emitted    = 0;
    epoch.bump             = ctx.bumps.epoch_state;

    emit!(EpochInitialised {
        epoch_number,
        start_slot:   clock.slot,
        epoch_budget: EPOCH_BUDGET,
    });

    Ok(())
}
pub fn advance_epoch(
    ctx:                  Context<AdvanceEpoch>,
    current_epoch_number: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let old   = &ctx.accounts.current_epoch_state;

    // guard 1: caller must supply the correct epoch number
    // prevents passing a stale epoch PDA to game the advance
    require!(
        old.epoch_number == current_epoch_number,
        VeloraError::EpochMismatch
    );

    // guard 2: epoch must have fully elapsed — strict slot check
    // saturating_sub prevents underflow if slot somehow goes backwards
    let elapsed = clock.slot.saturating_sub(old.epoch_start_slot);
    require!(elapsed >= EPOCH_SLOTS, VeloraError::EpochNotElapsed);

    let new_number = current_epoch_number
        .checked_add(1)
        .ok_or(VeloraError::MathOverflow)?;

    // initialise the next epoch PDA with a fresh full budget
    let next = &mut ctx.accounts.next_epoch_state;
    next.epoch_number     = new_number;
    next.epoch_start_slot = clock.slot;
    next.epoch_budget     = EPOCH_BUDGET;
    next.epoch_emitted    = 0;
    next.bump             = ctx.bumps.next_epoch_state;

    emit!(EpochAdvanced {
        old_epoch:      current_epoch_number,
        new_epoch:      new_number,
        old_emitted:    old.epoch_emitted,
        new_start_slot: clock.slot,
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

#[derive(Accounts)]
pub struct InitializeMint<'info> {
    /// Anyone can pay to create the mint — permissionless.
    #[account(mut)]
    pub payer: Signer<'info>,
 
    /// The single global Velora mint PDA.
    /// Mint authority = this PDA itself (program controls all minting).
    /// Freeze authority = None (tokens are non-freezable).
    ///
    /// space for a Token-2022 Mint with no extensions:
    ///   Mint base size = 82 bytes (from spl_token_2022::state::Mint::LEN)
    #[account(
        init,
        payer     = payer,
        seeds     = [MINT_SEED],
        bump,
        mint::decimals  = TOKEN_DECIMALS,
        mint::authority = mint,         // PDA is its own mint authority
        mint::token_program = token_program,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
 
    pub token_program:  Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
 
#[derive(Accounts)]
#[instruction(epoch_number: u64)]
pub struct InitializeEpoch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
 
    /// EpochState PDA — one per epoch number.
    /// space: 8 + 8 + 8 + 8 + 8 + 1 = 41 + 8 discriminator = 49
    #[account(
        init,
        payer  = payer,
        space  = 8 + 8 + 8 + 8 + 8 + 1,
        seeds  = [EPOCH_SEED, &epoch_number.to_le_bytes()],
        bump
    )]
    pub epoch_state: Account<'info, EpochState>,
 
    pub system_program: Program<'info, System>,
}
 
#[derive(Accounts)]
#[instruction(current_epoch_number: u64)]
pub struct AdvanceEpoch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
 
    /// The epoch that is being closed out — must have elapsed.
    #[account(
        seeds  = [EPOCH_SEED, &current_epoch_number.to_le_bytes()],
        bump   = current_epoch_state.bump,
    )]
    pub current_epoch_state: Account<'info, EpochState>,
 
    /// The new epoch being initialised — must not exist yet.
    #[account(
        init,
        payer  = payer,
        space  = 8 + 8 + 8 + 8 + 8 + 1,
        seeds  = [EPOCH_SEED, &(current_epoch_number + 1).to_le_bytes()],
        bump
    )]
    pub next_epoch_state: Account<'info, EpochState>,
 
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_number: u64)]
pub struct ClaimEmission<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
 
    // read-only — only checking is_active
    #[account(
        seeds   = [b"operator", operator.key().as_ref()],
        bump    = operator_registry.bump,
        has_one = operator @ VeloraError::UnauthorizedOperator,
    )]
    pub operator_registry: Account<'info, OperatorRegistry>,
 
    // mut — we update last_claim_epoch after minting
    #[account(
        mut,
        seeds   = [b"score", operator.key().as_ref()],
        bump    = score_card.bump,
        has_one = operator @ VeloraError::UnauthorizedOperator,
    )]
    pub score_card: Account<'info, ScoreCard>,
 
    // mut — we update epoch_emitted after minting
    #[account(
        mut,
        seeds  = [EPOCH_SEED, &epoch_number.to_le_bytes()],
        bump   = epoch_state.bump,
    )]
    pub epoch_state: Account<'info, EpochState>,
 
    // mut — the global mint PDA. Signs the mint_to CPI.
    #[account(
        mut,
        seeds  = [MINT_SEED],
        bump,
        mint::token_program = token_program,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
 
    // mut — the operator's Associated Token Account (ATA) for the Velora token.
    // init_if_needed: creates the ATA on first claim automatically.
    #[account(
        init_if_needed,
        payer               = operator,
        associated_token::mint      = mint,
        associated_token::authority = operator,
        associated_token::token_program = token_program,
    )]
    pub operator_token_account: InterfaceAccount<'info, TokenAccount>,
 
    pub token_program:            Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
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


 

#[event]
pub struct EpochInitialised {
    pub epoch_number: u64,
    pub start_slot:   u64,
    pub epoch_budget: u64,
}
 
#[event]
pub struct EpochAdvanced {
    pub old_epoch:      u64,
    pub new_epoch:      u64,
    pub old_emitted:    u64,
    pub new_start_slot: u64,
}
 
#[event]
pub struct EmissionClaimed {
    pub operator:         Pubkey,
    pub epoch_number:     u64,
    pub amount_minted:    u64,
    pub ema_at_claim:     u64,
    pub volume_at_claim:  u64,
    pub budget_remaining: u64,
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

#[account]
pub struct EpochState {
    pub epoch_number:     u64, // 8
    pub epoch_start_slot: u64, // 8
    pub epoch_budget:     u64, // 8
    pub epoch_emitted:    u64, // 8
    pub bump:             u8,  // 1
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

pub fn isqrt(n: u64) -> u64 {
    if n == 0 { return 0; }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

pub fn pow_1_5_scaled(x: u64) -> u64 {
    if x == 0 { return 0; }
    let inner = x.saturating_mul(SCALE);    // upscale: x × 10^6
    let sq    = isqrt(inner);               // ≈ sqrt(x) × 10^3
    let denom = SCALE * isqrt(SCALE);       // 10^6 × 10^3 = 10^9
    x.saturating_mul(sq) / denom
}

pub fn log_scaled(x: u64) -> u64 {
    if x <= 1 { return 0; }
    let bits  = 63 - x.leading_zeros() as u64; // floor(log2(x))
    // ln(x) ≈ bits × ln(2), ln(2) ≈ 0.693147
    // scaled: bits × 693_147 / 1_000_000 × SCALE  = bits × 693_147
    bits.saturating_mul(693_147)
}

pub fn compute_emission(
    ema_reliability:  u64,
    total_volume:     u64,
    budget_remaining: u64,
    budget_total:     u64,
) -> u64 {
    if budget_remaining == 0 || budget_total == 0 { return 0; }
 
    // ema_factor: ema^1.5 in [0, SCALE]
    let ema_factor = pow_1_5_scaled(ema_reliability);
 
    // volume_factor: log(volume+1) normalised to [0, SCALE]
    // cap log at log(1_000_000 SOL in lamports) ≈ log(10^15) ≈ 50 bits
    // log_scaled(10^15) ≈ 50 × 693_147 = 34_657_350
    const LOG_CAP: u64 = 34_657_350;
    let volume_log    = log_scaled(total_volume.saturating_add(1)).min(LOG_CAP);
    let volume_factor = volume_log.saturating_mul(SCALE) / LOG_CAP; // → [0, SCALE]
 
    // budget_factor: how much of this epoch's budget is left
    let budget_factor = budget_remaining
        .saturating_mul(SCALE)
        .checked_div(budget_total)
        .unwrap_or(0);
 
    // combine all three factors with BASE_RATE.
    // divide by SCALE after each multiply to stay in u64 range.
    // order: BASE_RATE → apply ema → apply volume → apply budget
    let step1 = BASE_EMISSION_RATE.saturating_mul(ema_factor) / SCALE;
    let step2 = step1.saturating_mul(volume_factor) / SCALE;
    let step3 = step2.saturating_mul(budget_factor) / SCALE;
    step3
}





#[error_code]
pub enum VeloraError {
    #[msg("Fee basis points must be less than 10000")]
    FeeTooHigh,
    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,
    #[msg("No bond deposited — nothing to return")]
    NoBondDeposited,
    #[msg("Signer is not the operator of this account")]
    UnauthorizedOperator,
    #[msg("Operator is not active — register first")]
    InactiveOperator,
    #[msg("Bond is below the minimum required")]
    InsufficientBond,
    #[msg("Operator reliability is above slash threshold")]
    SlashConditionNotMet,
    #[msg("Operator has already been slashed and deactivated")]
    AlreadySlashed,
    #[msg("Merchant co-signature verification failed")]
    InvalidMerchantSignature,
    #[msg("Math overflow")]
    MathOverflow,
    // Week 3
    #[msg("Epoch has not elapsed yet — too early to advance")]
    EpochNotElapsed,
    #[msg("Epoch number does not match current epoch")]
    EpochMismatch,
    #[msg("Operator has already claimed emission this epoch")]
    AlreadyClaimedThisEpoch,
    #[msg("Not enough proofs submitted to claim emission")]
    InsufficientProofs,
    #[msg("Epoch budget exhausted for this epoch")]
    EpochBudgetExhausted,
}