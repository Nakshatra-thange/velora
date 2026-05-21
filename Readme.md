# Velora

**Proof-of-facilitation — a DePIN primitive on Solana where operators compete on reliability, merchants get auto-routed to the lowest-fee verified route, and token emissions are driven entirely by on-chain performance.**

> Velora is not a protocol. It is a primitive. Any payment network, cross-chain bridge, or liquidity router can plug in and inherit decentralised operator competition + permissionless slashing + token-incentivised reliability — all on-chain, no trusted intermediary.

---

## Live Demo

| Resource | Link |
|---|---|
| Devnet Program | `explorer.solana.com/address/YOUR_PROGRAM_ID?cluster=devnet` |
| Scoreboard UI  | `your-vercel-url.vercel.app` |
| Program ID     | `YOUR_PROGRAM_ID_HERE` |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  MERCHANT                                               │
│  VeloraSDK.getRoutes() → auto-selects lowest-fee route  │
└────────────────────┬────────────────────────────────────┘
                     │ POST /request
┌────────────────────▼────────────────────────────────────┐
│  AGGREGATOR (off-chain, Express)                        │
│  Reads all OperatorRegistry + ScoreCard PDAs on-chain   │
│  Scores: fee*0.4 + ema*0.4 + experience*0.2             │
│  Routes merchant → top-3 operators                      │
└────────────────────┬────────────────────────────────────┘
                     │ GET /requests (poll every 2s)
┌────────────────────▼────────────────────────────────────┐
│  OPERATOR SOLVER BOT (each operator runs their own)     │
│  Claims request → fulfills → submits submit_proof tx    │
└────────────────────┬────────────────────────────────────┘
                     │ CPI
┌────────────────────▼────────────────────────────────────┐
│  VELORA PROGRAM (Anchor, Solana)                        │
│                                                         │
│  register_operator   → OperatorRegistry PDA             │
│  deposit_bond        → EscrowVault PDA (slashable)      │
│  initialize_scorecard→ ScoreCard PDA (EMA starts 100%)  │
│  submit_proof        → verify merchant ed25519 cosig    │
│                        update EMA + volume on ScoreCard │
│  slash_operator      → permissionless, EMA < 70%        │
│                        20% of bond → cranker            │
│  initialize_mint     → Token-2022 PDA, program-owned    │
│  initialize_epoch    → EpochState PDA, 2-day budget     │
│  claim_emission      → mint_to via PDA signing          │
│                        f(ema^1.5 × log(volume) × budget)│
│  advance_epoch       → permissionless crank             │
└─────────────────────────────────────────────────────────┘
```

---

## What makes this technically hard

### 1. EMA reliability score in fixed-point Rust
Solana's BPF VM has no hardware FPU — `f64` is non-deterministic across validators and rejected at deploy time. Every percentage, ratio, and decay factor is stored as `u64` scaled by `1_000_000`. The EMA update:

```rust
new_ema = (950_000 * old_ema + 50_000 * new_score) / 1_000_000
```

Five consecutive zero-score proofs drops an operator from 100% → 77%. Permissionless slashing fires below 70%.

### 2. ed25519 instruction introspection for merchant co-signatures
Operators cannot fake fulfillment proofs. Every `submit_proof` transaction must include an Ed25519 precompile instruction at index `[n-1]` where the merchant has signed `borsh(FulfillmentProof)`. The program reads the Solana instructions sysvar, walks back one index, validates the precompile program ID, extracts the pubkey and message bytes, and compares against the proof payload — all on-chain.

```rust
let ed25519_ix = instructions::load_instruction_at_checked(
    current_index - 1,
    &ix_sysvar.to_account_info(),
)?;
require!(ed25519_ix.program_id == solana_program::ed25519_program::ID, ...);
```

### 3. Token-2022 PDA mint authority
The Velora token mint authority is the mint PDA itself — seeds `[b"velora_mint"]`. No human wallet can ever call `mint_to`. The only path to minting is through `claim_emission`, which enforces:
- operator is active
- ≥ 5 proofs submitted
- not already claimed this epoch
- epoch budget not exhausted

PDA signing in the CPI:
```rust
let mint_seeds: &[&[u8]] = &[MINT_SEED, &[mint_bump]];
let signer_seeds = &[mint_seeds];
CpiContext::new_with_signer(..., signer_seeds)
```

### 4. Emission formula with integer `x^1.5` and `log(x)`
```
emission = BASE_RATE × (ema^1.5 / SCALE) × (log(volume+1) / LOG_CAP) × (budget_remaining / budget_total)
```

`x^1.5` without floats: `x^1.5 = x × sqrt(x)`, using Newton's method integer square root. `log(x)` approximated via bit-length: `floor(log2(x)) × 693_147` (ln2 scaled). Both are monotonically increasing — sufficient for a fair emission formula.

### 5. Permissionless slashing with cranker incentive
Anyone can crank `slash_operator` when `ema_reliability < 700_000`. Cranker receives 20% of the operator's locked bond as a reward. The game theory: crankers are economically incentivised to monitor the scoreboard. Operators are economically incentivised to maintain quality to protect their bond.

---

## Program Accounts

| Account | Seeds | Size | Purpose |
|---|---|---|---|
| `OperatorRegistry` | `["operator", operator]` | 52B | fee, is_active, registration time |
| `EscrowVault` | `["escrow", operator]` | 57B | slashable bond in lamports |
| `ScoreCard` | `["score", operator]` | 82B | EMA, volume, fulfillment count |
| `EpochState` | `["epoch", epoch_number_le]` | 41B | budget, emitted, start slot |
| `Mint` (Token-2022) | `["velora_mint"]` | 82B | program-owned token mint |

---

## Quickstart

### Prerequisites
```bash
# Rust, Solana CLI 1.18+, Anchor 0.30+, Node 20+
anchor --version   # anchor-cli 0.30.x
solana --version   # solana-cli 1.18.x
```

### Install
```bash
git clone https://github.com/YOUR_GITHUB/velora
cd velora
npm install
anchor build
```

### Run tests
```bash
anchor test
# 12 tests — week 2 (6) + week 3 (6)
```

### Deploy to devnet
```bash
solana config set --url devnet
solana airdrop 2
anchor deploy
# copy program ID → declare_id! + Anchor.toml
anchor test --skip-deploy
```

### Start the aggregator
```bash
PROGRAM_ID=YOUR_PROGRAM_ID npx ts-node aggregator/index.ts
# → http://localhost:3001
```

### Run a solver node
```bash
PROGRAM_ID=YOUR_PROGRAM_ID \
OPERATOR_KEYPAIR=~/.config/solana/id.json \
npx ts-node solver/index.ts
```

### Merchant SDK (3 lines)
```typescript
import { VeloraSDK } from "./sdk";

const velora  = new VeloraSDK({ aggregatorUrl: "http://localhost:3001" });
const routes  = await velora.getRoutes(500_000_000);          // fetch routes
const best    = velora.selectBestRoute(routes);               // auto-select
const request = await velora.submitRequest(myPubkey, 500_000_000);
await velora.confirmFulfillment(request.request_id);          // wait for proof
```

### Run end-to-end demo
```bash
PROGRAM_ID=YOUR_PROGRAM_ID npx ts-node scripts/demo.ts
```

---

## Scoreboard frontend

```bash
cd app
npm install
NEXT_PUBLIC_AGGREGATOR_URL=http://localhost:3001 \
NEXT_PUBLIC_PROGRAM_ID=YOUR_PROGRAM_ID \
npm run dev
# → http://localhost:3000
```

Deploy to Vercel:
```bash
vercel --prod
```

---

## Project structure

```
velora/
├── programs/velora/src/lib.rs   # Anchor program — all on-chain logic
├── tests/velora.ts              # 12 integration tests
├── aggregator/index.ts          # Off-chain routing + request queue
├── solver/index.ts              # Operator bot — polls + submits proofs
├── sdk/index.ts                 # Merchant TypeScript SDK
├── scripts/
│   ├── demo.ts                  # End-to-end devnet demo
│   └── read-scoreboard.ts       # Terminal scoreboard reader
└── app/
    └── page.tsx                 # Next.js scoreboard UI
```

---

## Emission schedule

| Parameter | Value |
|---|---|
| Epoch length | ~2 days (172,800 slots) |
| Tokens per epoch | 1,000,000 VLRA |
| Min proofs to claim | 5 |
| Slash threshold | EMA < 70% |
| Slash penalty | 20% of bond |
| Cranker reward | 20% of slash amount |

---

## Resume bullets

- Built **Velora**, a proof-of-facilitation DePIN primitive on Solana — operators compete on reliability, merchants get auto-routed to lowest-fee verified routes, and SPL Token-2022 emissions are driven by on-chain EMA scores
- Implemented **ed25519 instruction introspection** for merchant co-signature verification — operators cannot submit fake proofs without a valid merchant signature verified against the Solana instructions sysvar
- Designed a **fixed-point emission formula** (`ema^1.5 × log(volume)`) in Rust with no floats, using Newton's method integer square root and bit-length log approximation; deployed permissionless slashing with cranker incentive game theory
- Built the full stack: Anchor program (8 instructions, 5 PDAs), off-chain aggregator (Express + on-chain reads), operator solver bot, TypeScript merchant SDK, and Next.js scoreboard frontend

---

*Built with Anchor 0.30 · Token-2022 · Solana devnet*