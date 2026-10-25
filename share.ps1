<#
.SYNOPSIS
  Share CivicAI with your team through one public HTTPS link (ngrok).

  Builds the web app, then opens three PowerShell windows and prints the link:
    API     http://127.0.0.1:8001   a second Django server for the link, with DEBUG off (start-dev.ps1 can keep running)
    web     http://127.0.0.1:4173   the production build; forwards /api and /media to that API
    ngrok   https://<name>.ngrok-free.app  ->  the web server
  The link works while the three windows stay open and this PC is on and online. Close them to stop sharing.
  While the ngrok window is open the PC does not go to sleep by itself (the screen can still turn off); closing the
  lid or choosing Sleep still suspends it, and the link with it. Running the script again replaces a previous share.
  Everyone using the link works on this PC's database.

  One-time setup: install ngrok (winget install Ngrok.Ngrok), create a free account at
  https://dashboard.ngrok.com/signup, then run:  ngrok config add-authtoken <your authtoken>

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\share.ps1
#>
param(
    # Internal: the mode the ngrok window runs in.
    [switch]$Tunnel
)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$py = Join-Path $backend 'venv\Scripts\python.exe'
$apiPort = 8001
$webPort = 4173

if (-not (Test-Path $py)) {
    Write-Host 'backend\venv not found - run .\setup.ps1 first.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $frontend 'node_modules'))) {
    Write-Host 'frontend\node_modules not found - run .\setup.ps1 first.' -ForegroundColor Red
    exit 1
}

# ngrok on PATH, or where winget installs it (PATH only includes it in terminals opened after the install).
$ngrok = (Get-Command ngrok -ErrorAction SilentlyContinue).Source
if (-not $ngrok) {
    $ngrok = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Ngrok.Ngrok_*\ngrok.exe') -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ngrok) {
    Write-Host 'ngrok not found - install it with:  winget install Ngrok.Ngrok' -ForegroundColor Red
    exit 1
}

# The ngrok window. It also asks Windows not to sleep for as long as it runs (ES_SYSTEM_REQUIRED, the same request a
# video player makes); Windows drops the request by itself when the window closes.
if ($Tunnel) {
    $host.UI.RawUI.WindowTitle = 'CivicAI share ngrok'
    Add-Type -Namespace CivicAI -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
    [void][CivicAI.Power]::SetThreadExecutionState([uint32]2147483649)  # ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1)
    Write-Host 'Keeping this PC awake while this window is open.' -ForegroundColor Green
    & $ngrok http "http://127.0.0.1:$webPort"
    return
}

$ngrokConfigs = @((Join-Path $env:LOCALAPPDATA 'ngrok\ngrok.yml'), (Join-Path $env:USERPROFILE '.ngrok2\ngrok.yml')) | Where-Object { Test-Path $_ }
$hasToken = $env:NGROK_AUTHTOKEN -or ($ngrokConfigs -and (Select-String -Path $ngrokConfigs -Pattern '^\s*authtoken:\s*\S' -Quiet))
if (-not $hasToken) {
    Write-Host 'ngrok has no authtoken yet. One-time setup:' -ForegroundColor Red
    Write-Host '  1. Create a free account:  https://dashboard.ngrok.com/signup'
    Write-Host '  2. Copy your authtoken:    https://dashboard.ngrok.com/get-started/your-authtoken'
    Write-Host "  3. Run:  & '$ngrok' config add-authtoken <your authtoken>"
    exit 1
}

# Running again replaces a previous share: close its windows together with the servers and ngrok they started.
$previous = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -like '*CivicAI share*' -or $_.CommandLine -like '*share.ps1*-Tunnel*' }
if ($previous) {
    Write-Host 'Closing the previous share...'
    $previous | ForEach-Object { taskkill /T /F /PID $_.ProcessId *> $null }
    Start-Sleep -Seconds 2
}
if ((Get-NetTCPConnection -State Listen -LocalPort $apiPort, $webPort -ErrorAction SilentlyContinue) -or (Get-Process ngrok -ErrorAction SilentlyContinue)) {
    Write-Host "Port $apiPort or $webPort is in use, or ngrok is already running - close that program first." -ForegroundColor Red
    exit 1
}

# The build calls the API on its own origin (/api), so the one public link serves both the app and the API.
Write-Host 'Building the web app...'
$env:VITE_API_URL = '/api'
Push-Location $frontend
npm run build
$built = $LASTEXITCODE -eq 0
Pop-Location
Remove-Item Env:VITE_API_URL
if (-not $built) {
    Write-Host 'Build failed - see the messages above.' -ForegroundColor Red
    exit 1
}

# Production settings for a public link: DEBUG off (no tracebacks), uploads served by Django, rate limits keyed on the
# visitor's IP from ngrok's X-Forwarded-For, https detected from its X-Forwarded-Proto (photo URLs). TLS ends at ngrok,
# so Django itself must not redirect to https or send HSTS.
$apiEnv = @(
    "`$env:DEBUG='False'"
    "`$env:ALLOWED_HOSTS='localhost,127.0.0.1,.ngrok-free.app,.ngrok-free.dev,.ngrok.app,.ngrok.dev,.ngrok.io'"
    "`$env:SERVE_MEDIA='True'"
    "`$env:NUM_PROXIES='1'"
    "`$env:SECURE_SSL_REDIRECT='False'"
    "`$env:SECURE_HSTS_SECONDS='0'"
) -join '; '
Start-Process powershell -WorkingDirectory $backend -ArgumentList @(
    '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'CivicAI share API :$apiPort'; $apiEnv; & '$py' manage.py runserver 127.0.0.1:$apiPort"
)
Start-Process powershell -WorkingDirectory $frontend -ArgumentList @(
    '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'CivicAI share web :$webPort'; `$env:CIVICAI_API_ORIGIN='http://127.0.0.1:$apiPort'; npx vite preview --host 127.0.0.1 --port $webPort --strictPort"
)

Write-Host 'Starting the servers...'
$ready = $false
for ($i = 0; $i -lt 90 -and -not $ready; $i++) {
    Start-Sleep -Seconds 1
    try { $ready = (Invoke-RestMethod "http://127.0.0.1:$webPort/api/health/" -TimeoutSec 2).status -eq 'ok' } catch { }
}
if (-not $ready) {
    Write-Host "The servers did not start - check the 'CivicAI share' windows for errors." -ForegroundColor Red
    exit 1
}

Start-Process powershell -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Tunnel')
$url = $null
for ($i = 0; $i -lt 30 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    try {
        $url = (Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2).tunnels |
            Where-Object { $_.public_url -like 'https://*' } | Select-Object -First 1 -ExpandProperty public_url
    } catch { }
}
if (-not $url) {
    Write-Host "ngrok did not open a link - check the 'CivicAI share ngrok' window for the error." -ForegroundColor Red
    exit 1
}

Set-Clipboard -Value $url
Write-Host ''
Write-Host 'Share this link with your team (copied to the clipboard):' -ForegroundColor Green
Write-Host "  $url" -ForegroundColor Green
Write-Host ''
Write-Host 'First visit: ngrok shows a notice page - click "Visit Site".'
Write-Host 'Demo logins: admin@civicai.local / Admin@12345, roads.officer1@civicai.local / Officer@12345, citizen@civicai.local / Citizen@12345'
Write-Host "To stop sharing, close the three 'CivicAI share' windows."
