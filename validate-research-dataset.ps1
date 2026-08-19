#Requires -Version 7

<#
.SYNOPSIS
Validates the research.jsonl dataset for completeness and quality.

.DESCRIPTION
Checks record types, correlation, schema, and provides statistics.
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$FilePath = "./apps/bot/research.jsonl",
    
    [Parameter(Mandatory=$false)]
    [switch]$Verbose
)

function Get-ResearchStats {
    param([string]$Path)
    
    if (-not (Test-Path $Path)) {
        Write-Host "File not found: $Path" -ForegroundColor Red
        return $null
    }
    
    $records = @()
    $content = Get-Content $Path -Raw
    $lines = $content -split "`n" | Where-Object { $_.Trim() }
    
    Write-Host "Reading $($lines.Count) lines from $Path..."
    
    foreach ($line in $lines) {
        if ($line.Trim()) {
            try {
                $record = $line | ConvertFrom-Json
                $records += $record
            } catch {
                Write-Host "Failed to parse line: $line" -ForegroundColor Yellow
            }
        }
    }
    
    return $records
}

# Load records
$records = Get-ResearchStats -Path $FilePath

if (-not $records) {
    Write-Host "No records found or file is empty" -ForegroundColor Red
    exit 1
}

Write-Host "`n=== RESEARCH DATASET VALIDATION ===" -ForegroundColor Cyan
Write-Host "File: $FilePath"
Write-Host "Total Records: $($records.Count)" -ForegroundColor Green

# Count by type
Write-Host "`n--- Record Type Distribution ---" -ForegroundColor Cyan
$byType = $records | Group-Object recordType
$byType | ForEach-Object {
    Write-Host "  $($_.Name): $($_.Count)" -ForegroundColor Green
}

# Unique tokens
$uniqueTokens = $records | Select-Object -ExpandProperty tokenMint -Unique | Measure-Object
Write-Host "`n--- Token Coverage ---" -ForegroundColor Cyan
Write-Host "  Unique Tokens: $($uniqueTokens.Count)" -ForegroundColor Green

# Schema validation
Write-Host "`n--- Schema Validation ---" -ForegroundColor Cyan
$invalidRecords = @()
foreach ($record in $records) {
    $issues = @()
    
    if ($record.schemaVersion -ne 1) {
        $issues += "schemaVersion != 1"
    }
    if (-not $record.recordType) {
        $issues += "missing recordType"
    }
    if (-not $record.recordedAt) {
        $issues += "missing recordedAt"
    }
    if (-not $record.recordId) {
        $issues += "missing recordId"
    }
    if (-not ($record.tokenMint -or $record.mint)) {
        $issues += "missing tokenMint/mint"
    }
    
    if ($issues) {
        $invalidRecords += @{
            Record = $record
            Issues = $issues
        }
    }
}

if ($invalidRecords) {
    Write-Host "  Found $($invalidRecords.Count) invalid records:" -ForegroundColor Yellow
    $invalidRecords | ForEach-Object { Write-Host "    - $($_.Issues -join ', ')" }
} else {
    Write-Host "  All records have valid schema" -ForegroundColor Green
}

# Redaction validation
Write-Host "`n--- Secret Redaction Validation ---" -ForegroundColor Cyan
$suspiciousRecords = @()
$sensitivePatterns = @('secret', 'token', 'key', 'password', 'private', 'auth')
foreach ($record in $records) {
    $recordJson = $record | ConvertTo-Json -Depth 10
    foreach ($pattern in $sensitivePatterns) {
        if ($recordJson -match $pattern -and $recordJson -notmatch '\[REDACTED\]') {
            if ($recordJson -match ":\s*['\"]?[a-zA-Z0-9_]{20,}") {
                $suspiciousRecords += $record.recordId
            }
        }
    }
}

if ($suspiciousRecords) {
    Write-Host "  WARNING: Found $($suspiciousRecords.Count) records with potential unredacted secrets" -ForegroundColor Yellow
} else {
    Write-Host "  Secrets appear properly redacted" -ForegroundColor Green
}

# Pipeline analysis
Write-Host "`n--- Pipeline Analysis ---" -ForegroundColor Cyan

# Group by token to see lifecycle
$byToken = $records | Group-Object tokenMint
$completeLifecycles = 0
$partialLifecycles = 0

foreach ($tokenGroup in $byToken) {
    $types = $tokenGroup.Group | Select-Object -ExpandProperty recordType -Unique
    $hasDiscovery = 'DISCOVERY' -in $types
    $hasObservation = 'OBSERVATION' -in $types
    $hasDecision = 'DECISION' -in $types
    $hasExecution = 'EXECUTION' -in $types
    $hasOutcome = 'OUTCOME' -in $types
    
    if ($hasDiscovery -and $hasObservation -and $hasDecision -and $hasExecution -and $hasOutcome) {
        $completeLifecycles++
    } elseif ($hasDiscovery) {
        $partialLifecycles++
    }
}

Write-Host "  Complete Lifecycles (D→O→D→E→O): $completeLifecycles" -ForegroundColor Green
Write-Host "  Partial Lifecycles (has DISCOVERY): $partialLifecycles" -ForegroundColor Cyan
Write-Host "  Total Tokens Analyzed: $($byToken.Count)" -ForegroundColor Green

# Decision distribution
$decisions = $records | Where-Object { $_.recordType -eq 'DECISION' } | Group-Object decision
if ($decisions) {
    Write-Host "`n--- Decision Distribution ---" -ForegroundColor Cyan
    $decisions | ForEach-Object {
        Write-Host "  $($_.Name): $($_.Count)" -ForegroundColor Green
    }
}

# Execution status
$executions = $records | Where-Object { $_.recordType -eq 'EXECUTION' } | Group-Object executionStatus
if ($executions) {
    Write-Host "`n--- Execution Status Distribution ---" -ForegroundColor Cyan
    $executions | ForEach-Object {
        Write-Host "  $($_.Name): $($_.Count)" -ForegroundColor Green
    }
}

Write-Host "`n=== VALIDATION COMPLETE ===" -ForegroundColor Cyan
