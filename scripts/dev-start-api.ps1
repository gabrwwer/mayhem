Set-Location -Path "C:\dev\mayhem\mq"
$env:API_AUTH_TOKEN = 'testtoken'
$env:INTERNAL_API_SECRET = 'internalsecret'
$env:DRY_RUN = 'true'
$env:TRADING_ENABLED = 'false'
Write-Host "Starting API (@mayhem/api) with DRY_RUN=$env:DRY_RUN"
pnpm --filter @mayhem/api dev
