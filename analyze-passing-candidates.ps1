# MAYHEM — PASSING-CANDIDATE FORWARD-OUTCOME RESEARCH
# PURPOSE:
# Collect naturally passing candidates WITHOUT changing entry criteria
# and measure their subsequent price behavior.
#
# IMPORTANT:
# - DO NOT enable trading.
# - DO NOT loosen existing rejection thresholds.
# - DO NOT change MIN_MOMENTUM_SAMPLES.
# - DO NOT create synthetic "winning" candidates.
# - Only candidates that naturally pass the existing pipeline are tracked.
#
# Research objective:
# Determine which combinations of momentum, volume/activity, transactions,
# buyers, net flow, buy pressure, volatility and drawdown predict positive
# forward price movement.

$ErrorActionPreference = "Stop"

$Root = (Get-Location).Path
$ResearchFile = Join-Path $Root "apps\bot\data\research.jsonl"

if (!(Test-Path $ResearchFile)) {
    throw "Research file not found: $ResearchFile"
}

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host " MAYHEM PASSING-CANDIDATE RESEARCH AUDIT" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Research file:"
Write-Host $ResearchFile
Write-Host ""

# ------------------------------------------------------------
# 1. Parse research records
# ------------------------------------------------------------

$records = Get-Content $ResearchFile |
    Where-Object { $_.Trim().Length -gt 0 } |
    ForEach-Object {
        try {
            $_ | ConvertFrom-Json
        }
        catch {
            Write-Warning "Invalid JSON record skipped"
        }
    }

Write-Host "Total research records: $($records.Count)"
Write-Host ""

# ------------------------------------------------------------
# 2. Identify decision records
# ------------------------------------------------------------

$decisions = @(
    $records |
    Where-Object {
        $_.recordType -eq "DECISION" -and
        $_.event -eq "DECISION_POINT"
    }
)

Write-Host "Decision records: $($decisions.Count)"
Write-Host ""

# ------------------------------------------------------------
# 3. Current natural-pass candidates
#
# IMPORTANT:
# We do NOT invent our own entry criteria here.
# A candidate qualifies only when the existing bot records
# it as something other than REJECT.
# ------------------------------------------------------------

$passes = @(
    $decisions |
    Where-Object {
        $_.decision -notin @(
            "REJECT",
            "REJECTED",
            "BLOCK",
            "BLOCKED"
        )
    }
)

Write-Host "Naturally passing candidates: $($passes.Count)" -ForegroundColor Green
Write-Host ""

if ($passes.Count -eq 0) {
    Write-Host "NO NATURAL PASSES FOUND YET." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "This is important:"
    Write-Host "The current strategy has not produced an entry candidate."
    Write-Host "Do NOT loosen thresholds just to manufacture candidates."
    Write-Host ""
    exit 0
}

# ------------------------------------------------------------
# 4. Display passing candidates
# ------------------------------------------------------------

$passes |
    Select-Object `
        recordedAt,
        tokenMint,
        decision,
        stage,
        initialPrice,
        finalPrice,
        netFlowPct,
        buyPressure,
        flowBuyPressure,
        maxDrawdownPct,
        finalDrawdownPct,
        volatility,
        samples |
    Format-Table -AutoSize

# ------------------------------------------------------------
# 5. Look for matching observations
#
# The observation immediately associated with the decision gives
# us the state of the token when it became a candidate.
# ------------------------------------------------------------

$candidateRows = foreach ($decision in $passes) {

    $mint = $decision.tokenMint

    $obs = @(
        $records |
        Where-Object {
            $_.recordType -eq "OBSERVATION" -and
            $_.event -eq "MOMENTUM_EVALUATION" -and
            (
                $_.tokenMint -eq $mint -or
                $_.mint -eq $mint
            )
        } |
        Sort-Object {
            try { [datetime]$_.observedAt }
            catch { [datetime]::MinValue }
        }
    )

    $latest = $obs | Select-Object -Last 1

    [PSCustomObject]@{
        CandidateTime      = $decision.recordedAt
        Mint               = $mint
        Decision           = $decision.decision
        Stage              = $decision.stage

        InitialPrice       = $decision.initialPrice
        FinalPrice         = $decision.finalPrice

        NetFlowPct         = $decision.netFlowPct
        BuyPressure        = $decision.buyPressure
        FlowBuyPressure    = $decision.flowBuyPressure

        MaxDrawdownPct     = $decision.maxDrawdownPct
        FinalDrawdownPct   = $decision.finalDrawdownPct

        Volatility         = $decision.volatility
        Samples            = $decision.samples

        ObservationTime    = $latest.observedAt
    }
}

# ------------------------------------------------------------
# 6. Export candidate snapshot
# ------------------------------------------------------------

$OutDir = Join-Path $Root "apps\bot\data\research"

if (!(Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$CandidateFile = Join-Path $OutDir "passing-candidates.csv"

$candidateRows |
    Export-Csv $CandidateFile -NoTypeInformation

Write-Host ""
Write-Host "Passing candidate snapshot:"
Write-Host $CandidateFile -ForegroundColor Green
Write-Host ""

# ------------------------------------------------------------
# 7. Research requirements for forward outcomes
# ------------------------------------------------------------

Write-Host "===============================================" -ForegroundColor Cyan
Write-Host " REQUIRED FORWARD-OUTCOME DATA" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "For every natural-pass candidate, the recorder should capture:"
Write-Host ""
Write-Host "  +5s   price"
Write-Host "  +10s  price"
Write-Host "  +30s  price"
Write-Host "  +60s  price"
Write-Host "  +120s price"
Write-Host "  +300s price"
Write-Host ""
Write-Host "And calculate:"
Write-Host ""
Write-Host "  forwardReturnPct"
Write-Host "  maximumFavorableExcursionPct"
Write-Host "  maximumAdverseExcursionPct"
Write-Host "  timeToPeakMs"
Write-Host "  timeToDrawdownMs"
Write-Host "  outcomeAt5s"
Write-Host "  outcomeAt10s"
Write-Host "  outcomeAt30s"
Write-Host "  outcomeAt60s"
Write-Host "  outcomeAt120s"
Write-Host "  outcomeAt300s"
Write-Host ""

# ------------------------------------------------------------
# 8. Check whether forward outcome fields already exist
# ------------------------------------------------------------

$forwardFields = @(
    "forwardReturnPct",
    "maximumFavorableExcursionPct",
    "maximumAdverseExcursionPct",
    "timeToPeakMs",
    "timeToDrawdownMs"
)

foreach ($field in $forwardFields) {

    $count = @(
        $records |
        Where-Object {
            $null -ne $_.$field
        }
    ).Count

    if ($count -gt 0) {
        Write-Host "$field : $count records" -ForegroundColor Green
    }
    else {
        Write-Host "$field : NOT PRESENT YET" -ForegroundColor Yellow
    }
}

Write-Host ""

# ------------------------------------------------------------
# 9. Do not claim profitability yet
# ------------------------------------------------------------

Write-Host "===============================================" -ForegroundColor Cyan
Write-Host " INTERPRETATION" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

if ($passes.Count -lt 30) {

    Write-Host "Insufficient natural-pass sample size for predictive conclusions."
    Write-Host ""
    Write-Host "Continue collecting observations."
}
else {

    Write-Host "Natural-pass candidates exist."
    Write-Host ""
    Write-Host "However, profitability cannot be inferred from passing status alone."
    Write-Host "Forward price outcomes must be joined to each candidate."
}

Write-Host ""
Write-Host "NO LIVE TRADING CHANGES WERE MADE." -ForegroundColor Green
Write-Host ""
