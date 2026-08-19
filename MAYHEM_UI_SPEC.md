# MAYHEM UI / PRODUCT DESIGN SPECIFICATION

Status: Design target
Purpose: Source of truth for the Mayhem dashboard UI

IMPORTANT:
This document describes the intended product/UI design.
Metrics, token data, latency values, scores, wallet balances, and transaction examples
shown in this document are DEMO/ILLUSTRATIVE DATA unless they are supplied by the
actual Mayhem backend.

Do not invent backend capabilities simply because they appear in a mockup.
The UI must reflect actual backend/API capabilities where available.

MAYHEM COMMAND CENTER

The next-generation Solana trading command center — built for crypto-native traders, developers, and advanced Solana users who demand speed, precision, and total market control.

Sidebar Navigation

Unified access to every module — positions, discovery, intelligence, risk, and configuration — from a single persistent control rail.

Header & Status Bar

Live system status, wallet connectivity, RPC health, and network latency displayed at all times across the top of the interface.

Portfolio Overview

Real-time aggregate P&L, portfolio value, open positions count, and daily performance delta — always visible above the fold.

Market Intelligence

Live token feeds, smart-money alerts, and signal engine output stream directly into the dashboard surface without context switching.

Built on Solana

Native RPC and WebSocket connectivity. Optimized execution latency. Native Solana RPC and WebSocket connectivity.

Command. Control. MAYHEM.

Every tool a serious Solana trader needs — scanner, terminal, risk engine, execution panel — unified inside one desktop-grade command center. No fragmentation. No tab switching. No compromises.

Main Dashboard

Full UI — What You See When You Land

The MAYHEM main dashboard is a dense, information-rich surface designed to keep traders oriented across every critical dimension simultaneously. No blank space. No fluff. Every pixel earns its place.

Open Positions Panel

Active trades displayed with live unrealized P&L, entry price, current price, and position age. Color-coded by performance — green for profit, red for drawdown — updating in real time via WebSocket.

P&L Summary

Realized and unrealized profit/loss aggregated at session, daily, and all-time levels. Sparkline trend lines surface momentum at a glance without requiring a separate analytics view.

Live Token Feed

Streaming token discovery feed ranked by MAYHEM Score, volume surge, and holder velocity. New launches, breakouts, and liquidity events surface automatically — no manual scanning required.

Alerts & Signals

Signal engine output appears inline — stop-loss triggers, take-profit targets hit, smart-money wallet movements, and risk threshold breaches are all surfaced as prioritized, dismissable alerts.

Activity Log

Chronological record of every trade execution, order confirmation, system event, and risk engine action. Timestamped to the millisecond. Filterable by type, token, or severity.

The main dashboard consolidates token discovery, market intelligence, execution, risk management, and portfolio monitoring into one unified surface.

Token Discovery

Scanner — Find Every Edge Before the Crowd

MAYHEM's Token Discovery module is a dense, sortable, filterable scanner table that surfaces every token on Solana with the data density serious traders need. Think Bloomberg terminal, not a DEX aggregator.

MAYHEM Score

Proprietary composite score (0–100) for every token. Ranks signal strength, liquidity safety, momentum, and holder quality in a single actionable number.

Liquidity Depth

Real-time liquidity across all DEX pools. Slippage estimates at $1K, $10K, and $100K trade sizes surfaced inline in the table row.

Volume & Momentum

1m, 5m, 1h, and 24h volume with directional delta. Surge detection flags tokens with anomalous volume acceleration before they print on social feeds.

Holder Analytics

Holder count, distribution, top-10 concentration, and growth velocity. Configurable wallet-activity and accumulation indicators appear inline.

 Filter & Sort Controls

Score ≥ 70

MAYHEM Score threshold filter — hide low-signal noise

Liq: $50K–$5M

Min/max liquidity depth range across all DEX pools

Vol Surge ≥ 3×

Volume surge multiplier vs. 24h baseline — flag anomalies

Holder Δ ≥ 5%

Holder growth rate filter — find accumulation events early

DEX: All

Raydium · Orca · Meteora · Jupiter — toggle any source

 Smart-Money

Show only tokens with smart-money wallet accumulation flags

 Live Scanner — 247 tokens matching filters · Updated via WebSocket

Token

Score

Price

Δ 1m

Vol 1m

Vol 5m

Vol 1h

Liquidity

Holders

Growth

DEX

Flag

Action

BLZEBlzeF…4kR

94

$0.04821

+8.4%

$142K

$891K

$3.2M

$1.8M

12,441

+18.2%

Raydium

 ×3

BUY · SELL

MNGOMngo9…2wQ

88

$0.00312

+5.1%

$78K

$412K

$1.9M

$920K

8,204

+12.7%

Orca

 ×2

BUY · SELL

FOMOFomoX…9pL

82

$0.00089

+3.8%

$51K

$287K

$1.1M

$540K

5,891

+9.3%

Meteora

 surge

BUY · SELL

WAGMIWagM1…7nT

79

$0.12450

+2.2%

$33K

$198K

$870K

$3.1M

21,302

+6.8%

Raydium

—

BUY · SELL

COPECope4…1mZ

74

$0.00541

-1.4%

$22K

$109K

$504K

$280K

3,471

+4.1%

Orca

 ×1

BUY · SELL

RUGGRugg8…3xW

31

$0.00002

-22.7%

$4K

$18K

$61K

$42K

801

-31.4%

Raydium

 risk

BUY · SELL

NUKENuke2…6hA

18

$0.00007

-41.2%

$1K

$7K

$29K

$18K

244

-58.9%

Meteora

 rug

BUY · SELL

Score Legend

80–100 — Strong signal. High conviction entry zone.

60–79 — Moderate signal. Monitor with tight stops.

0–59 — Weak / risky. Avoid or short only.

Flag Key

 ×N — Wallet accumulation activity detected (N = wallet count)

 surge — Volume anomaly detected vs. 24h baseline

 risk / rug — Liquidity withdrawal or holder dump signal

One-click execution: Hit BUY or SELL directly from any scanner row — no navigation required. Trade parameters auto-populate from your active risk profile.

Token Intelligence Terminal

Deep Dive — Every Signal, One Screen

Click any token in the scanner and the Intelligence Terminal opens — a full-detail view that replaces four separate tools: charting, on-chain analytics, holder analysis, and transaction inspection.

Price Chart

Candlestick chart with 1m, 5m, 15m, 1h, and 4h timeframes. Volume bars, VWAP overlay, and MAYHEM Signal markers plotted directly on the chart surface.

Market Statistics

Market cap, fully diluted valuation, circulating supply, ATH/ATL, and 24h high/low. All live — no cached data, no stale snapshots.

Liquidity Analysis

Pool-by-pool liquidity breakdown. Concentration risk detection — flags when >60% of liquidity sits in a single pool or wallet-controlled LP position.

Holder Distribution

Top-50 holder wallet breakdown with balance, % of supply, smart-money tags, and accumulation/distribution direction over 24h and 7d windows.

Transaction Feed

Live on-chain transaction stream: buys, sells, LP adds/removes, and authority actions. Wallet labels for known entities (market makers, whales, insiders).

Authority Status

Mint authority, freeze authority, and upgrade authority status. Wallet-activity indicators surface in real time as authorities change status or are renounced post-launch.

Proprietary Signal

MAYHEM Score — The Edge, Quantified

A composite 0–100 signal computed in real time across six independent scoring components. Forward-looking, not lagging — every dimension of the platform distilled into one actionable number.

◉ MAYHEM SCORE

87

STRONG SIGNAL

Score Interpretation

85 – 100

Strong Signal

70 – 84

Elevated Signal

50 – 69

Monitor / Neutral Signal

30 – 49

Caution / Risk

0 – 29

Avoid / High Risk

Six Scoring Components

 Liquidity Safety 92 / 100

Pool depth, concentration risk, LP lock status. Strong — fully locked, diversified pools.

 Momentum 88 / 100

Price velocity, volume surge, breakout patterns. Strong — multi-timeframe breakout confirmed.

 Holder Growth 79 / 100

Holder count velocity, distribution improvement. Elevated — top-10 concentration declining.

 Smart-Money Activity 91 / 100

High-PnL wallet accumulation, alpha group flows. Strong — 4 known alpha wallets accumulating.

 Risk Indicators 63 / 100

Authority status, contract flags, insider concentration. Caution — freeze authority not yet renounced.

 Signal Confluence 85 / 100

Cross-component agreement weighting. Strong — 5 of 6 components above 79.

Position Management

Open Positions — Full Control, Zero Guesswork

The Positions module is the operational heart of MAYHEM — a live, interactive table where every open trade is managed with institutional-grade precision controls. No spreadsheets. No manual tracking. Every position, every metric, one surface.

Total Unrealized P&L

Across all open positions

Open Positions

2 profitable · 1 at risk

Total Exposure

Deployed capital

Avg MAYHEM Score

Portfolio-weighted signal

Token

Entry Price

Current Price

Size (SOL)

Unrealized P&L

P&L %

Stop Loss

Take Profit

Score

Actions

BONK ● LIVE

$0.0000312

$0.0000441

25.0 SOL

+$412.80

+41.3%

$0.0000270 Trailing 8%

$0.0000520 TP1 · TP2

96

Modify · Partial · Close

WIF ● LIVE

$2.8400

$2.6100

10.0 SOL

−$184.60

−8.1%

$2.5000 Near SL

$3.4000 TP1

71

Modify · Partial · Close

POPCAT ● LIVE

$0.6120

$0.8910

15.0 SOL

+$4,593.00

+45.6%

Trailing 8% HWM: $0.91

$1.1000 TP1 · TP2 · TP3

94

Modify · Partial · Close

MYRO ● LIVE

$0.1043

$0.1381

8.0 SOL

+$218.40

+32.4%

$0.0950 Fixed

$0.1600 TP1 · TP2

88

Modify · Partial · Close

Risk Control Panel

Stop Loss

Fixed price or percentage-based stop. Executes automatically via the risk engine — no manual intervention required at trigger. Supports both hard stops and trailing stops ratcheted to a rolling high-water mark.

Take Profit

Single target or multi-leg ladder. Define up to 4 take-profit levels with percentage of position to close at each level. Remaining position continues to run until the next level or a stop is hit.

Trailing Stop

Dynamic stop that ratchets upward with price. Configured as a fixed percentage below the rolling high-water mark. Locks in gains automatically as a position moves into profit.

Partial Close

Close any percentage of a position from the table row — lock profit on a portion while letting the rest run. No re-entry required. Executes instantly at market via the execution engine.

Trade Execution

Execution Panel — Every Parameter, Fully Controlled

MAYHEM's execution panel exposes every variable that matters at trade time. No black-box routing. No hidden fees. No surprise slippage. You see exactly what you're getting before the transaction hits the chain.

BUY ◈ BONK

SELL ◈ SOL

 Wallet Balance

42.381 SOL  ·  $6,241.87 USD

Available (net of gas reserve): 41.881 SOL

Order Size

Input: 10.000 SOL  ≈  $1,471.40

                25%                  50%                  75%                  MAX              

Slippage Tolerance

0.1%  0.5%   1.0%   Auto

Custom BPS: 100

Priority Fee

 Dynamic   Manual

Est. fee: 0.000021 SOL

 SIMULATE TRANSACTION

Preview exact output · Zero risk · Full pre-flight

 EXECUTE TRADE

Broadcast to chain · Confirmed in next block

⟳ Route Optimization

Jupiter Aggregator · Best-price path

SOL → USDC → BONK

Pools: Orca Whirlpool · Raydium CLMM

Hops: 2  ·  Best rate across 14 routes checked

 Price Impact

0.43%  — Low impact ✓

>1% → Warning  ·  >3% → Hard block

✓ Simulation Preview

Input: 10.000 SOL

Expected Output: 32,184,210 BONK

Min. Received (1% slip): 31,862,368 BONK

Network Fee: 0.000021 SOL

Total Cost: 10.000021 SOL

 Last Confirmation

Tx Sig: 5xK2…r9Pq

Block: #289,441,827  ·  Time: 0.41s

Fill Price: $0.0000312  ·  Actual Slip: 0.38%

Simulation Mode runs the transaction against the live chain state using Solana's transaction simulation API, providing pre-flight output and estimated results before committing SOL.

Risk Center

Risk Center — Protect the Stack at All Times

The Risk Center is MAYHEM's automated guardrail system. It enforces trader-defined limits at the engine level — not in the UI, not manually, but at execution time. When limits are hit, the engine acts. No hesitation. No override required.

Risk Metric

Limit

Current

Status

Portfolio Exposure

80%

43.2%

● SAFE

Largest Single Position

25%

21.8%

● CAUTION

Daily Drawdown

−10%

−3.4%

● SAFE

Min Pool Liquidity

$50K

$31K ↓

● ALERT

Open Positions

12 max

7

● SAFE

Slippage Exposure

1.5% avg

0.82%

● SAFE

▣ PORTFOLIO EXPOSURE

━━━━━━━━━━━━━━━━━━━━

43%

of 80% hard cap

■■■■■■■■■■■■■■■■■■■■

0%                    80%

◈ DAILY LOSS TRACKER

−3.4%

ceiling: −10%  |  remaining: 6.6%

████████████

⬡ EXIT CONTROLS

Stop Loss

ACTIVE · −8% triggerMarket sell · 1% slip budget

Take Profit

ACTIVE · +25% / +50%Ladder: 50% at leg 1, 50% at leg 2

Trailing Stop

STANDBY · 5% trailActivates after +10% unrealized

◎ POSITION LIMITS

Max Position Size

25% cap · 21.8% used1.2% headroom remaining

Per-Category Cap

40% DeFi · 28% used30% Meme · 11% used

Liquidity Gate

1 token BLOCKEDPool below $50K threshold

 EMERGENCY STOP

Immediately initiates the configured emergency-exit procedure for all eligible open positions. Clearly displays consequences and execution status.

━━━━━━━━━━━━━━

 STOP

━━━━━━━━━━━━━━

7 positions · ~43.2 SOL exposureEst. execution: <2 blocks

1 ACTIVE ALERT: SOL/BONK pool liquidity has dropped below the $50K minimum threshold. New entries into this token are blocked by the liquidity gate. Existing position is flagged — review exit conditions immediately.

Configuration

Configuration — Full Stack Control for Power Users

MAYHEM exposes every system parameter to the user. No hidden defaults. No locked settings. Every engine behavior, network connection, and safety limit is configurable from a single structured settings panel.

Trading Strategy

Default order type (market / limit / smart), position sizing method, auto-compound rules, and preferred DEX routing preferences configured per trading session.

Execution Settings

Default slippage tolerance, priority fee mode (auto / manual / aggressive), transaction retry count, confirmation timeout, and block landing target configuration.

RPC Configuration

Primary and failover RPC endpoint configuration. Supports Helius, QuickNode, Triton, or custom endpoints. Latency testing built in — benchmark your RPC before trading.

WebSocket Settings

WebSocket endpoint, reconnection policy, subscription filters (accounts, programs, token mints), and heartbeat interval for maintaining persistent data streams.

Monitoring

Alert thresholds for system health events: RPC latency spikes, WebSocket disconnections, missed blocks, and execution engine queue depth warnings.

Safety Controls

Global kill switch, maximum daily trade volume cap, anti-MEV configuration, simulation-before-send enforcement toggle, and smart-contract interaction whitelist.

System Health

System Health + Activity — See Inside the Machine

MAYHEM surfaces the operational state of every internal engine and external connection in real time. You always know what the system is doing, what it has done, and whether every component is running at full capacity.

System Health Panel

Component

Status

Latency

Key Metric

API Layer

● Active

11ms

99.9% uptime / auto-failover

Primary RPC

● Active

8ms

100% avail / Helius endpoint

Backup RPC

● Standby

24ms

QuickNode / ready to engage

WebSocket

● Active

3ms

Stream live / connection status monitored

Token Monitor

● Active

23ms

847 tokens tracked

Risk Engine

● Active

5ms

0 limit breaches / all clear

Execution Engine

● Active

18ms

Queue depth: 0 / idle

Signal Engine

● Active

31ms

12 signals / last 60s

Intelligence Engine

● Active

15ms

MAYHEM Score refresh: ~15s

99.9%

API Uptime

18ms

Avg Exec Latency

0

Queue Depth

847

Tokens Live

Event Log — Live Feed

Timestamp

Severity

Engine

Event Detail

14:32:07.441

INFO

Execution

BUY executed — SOL/USDC — 2.4 SOL @ $183.22 — 16ms fill

14:32:05.118

INFO

Signal

Momentum signal triggered — BONK — score 87 — entry queued

14:31:58.803

INFO

Intelligence

MAYHEM Score updated — WIF: 91 → 94 — momentum rising

14:31:44.227

WARN

RPC

Primary RPC latency spike — 312ms — failover evaluated, not needed

14:31:39.992

INFO

Risk

Position size validated — within daily cap — trade approved

14:31:22.504

INFO

Token Monitor

New token listed — PUMP.FUN — added to watchlist, scanning

14:30:58.017

CRIT

Risk

Stop-loss triggered — JUP — threshold breached — position closed

14:30:41.339

WARN

WebSocket

Reconnect event — 1.2s gap — backfill complete, no data lost

14:30:29.771

INFO

Execution

SELL executed — BONK — 1.2M tokens @ $0.00003141 — 21ms fill

14:30:11.450

INFO

Config

Slippage tolerance updated — 0.5% → 1.0% — applied immediately

14:29:53.088

INFO

Signal

Reversal signal — RAY — score 72 — below threshold, no action

14:29:38.204

WARN

Execution

Retry #1 — tx not confirmed — rebroadcasting with higher fee

Log filterable by engine · severity · time window — exportable as JSON or CSV

Architecture

Complete MAYHEM Architecture — Built Different, Down to the Chain

MAYHEM is not a frontend wrapper around a third-party API. It is a multi-engine system with native Solana connectivity, purpose-built components for every function, and a data flow architecture designed for sub-second latency at every layer.

Every trade flows through the full stack — from on-chain data ingestion via WebSocket, through token monitoring and intelligence scoring, into signal generation, risk validation, and finally execution via wallet and DEX — with the dashboard and database capturing every event in real time.

Solana + RPC/WS

Native on-chain data. No intermediary. Direct RPC and WebSocket subscriptions to program accounts, token mints, and transaction streams.

Token Monitor + Intelligence

Continuous scanning of 800+ tokens. MAYHEM Score recomputed every ~15 seconds across all six scoring dimensions.

Signal + Risk Engines

Signal engine generates trade opportunities. Risk engine validates every signal and order against live portfolio limits before anything reaches execution.

Execution + Wallet/DEX

Optimized transaction construction and broadcasting. Jupiter-routed swaps with configurable slippage, priority fees, and anti-MEV protection.

Dashboard + API + DB

Real-time UI fed by internal API. All events, positions, and system state persisted to local database for audit, analysis, and session continuity.