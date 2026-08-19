Set-Location -Path "C:\dev\mayhem\mq"
$env:API_URL = 'http://127.0.0.1:3001'
$env:API_AUTH_TOKEN = 'testtoken'
$env:INTERNAL_API_SECRET = 'internalsecret'
$env:DRY_RUN = 'true'
$env:TRADING_ENABLED = 'false'
$env:HEALTH_PORT = '3010'
Write-Host "Starting Bot (@mayhem/bot) with DRY_RUN=$env:DRY_RUN"
pnpm --filter @mayhem/bot dev
