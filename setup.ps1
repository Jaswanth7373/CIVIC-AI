<#
.SYNOPSIS
  First-time setup of CivicAI on Windows (backend virtualenv, Python + npm packages, .env files,
  database tables, reference data and demo data).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup.ps1            # SQLite or whatever backend\.env says
  powershell -ExecutionPolicy Bypass -File .\setup.ps1 -NoSeed     # skip the demo data
  powershell -ExecutionPolicy Bypass -File .\setup.ps1 -WithML     # also install PyTorch / transformers (production AI)

.NOTES
  Requires Python 3.11+ (3.13 recommended) and Node.js 20+ on PATH. For MySQL, first set the DATABASE_* values and
  DB_ENGINE=mysql in backend\.env, then run:  backend\venv\Scripts\python.exe backend\scripts\setup_mysql.py
#>
param(
    [switch]$NoSeed,
    [switch]$WithML
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$py = Join-Path $backend 'venv\Scripts\python.exe'

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Green }

Step 'Backend virtual environment'
if (-not (Test-Path $py)) {
    python -m venv (Join-Path $backend 'venv')
}
& $py -m pip install --upgrade pip | Out-Null
& $py -m pip install -r (Join-Path $backend 'requirements.txt')
if ($WithML) {
    Step 'Deep-learning packages for MODEL_MODE=production (large download)'
    & $py -m pip install -r (Join-Path $backend 'requirements-ml.txt')
}

Step 'Backend .env'
$envFile = Join-Path $backend '.env'
if (-not (Test-Path $envFile)) {
    $secret = & $py -c "import secrets; print(secrets.token_urlsafe(50))"
    $jwt = & $py -c "import secrets; print(secrets.token_urlsafe(50))"
    $content = Get-Content (Join-Path $backend '.env.example') -Raw
    $content = $content -replace '(?m)^SECRET_KEY=.*$', "SECRET_KEY=$secret"
    $content = $content -replace '(?m)^JWT_SECRET=.*$', "JWT_SECRET=$jwt"
    # Start on SQLite so the project runs immediately; switch to MySQL later (see README).
    $content = $content -replace '(?m)^DB_ENGINE=mysql$', 'DB_ENGINE=sqlite'
    Set-Content -Path $envFile -Value $content -Encoding utf8
    Write-Host 'Created backend\.env with fresh secrets (DB_ENGINE=sqlite).'
} else {
    Write-Host 'backend\.env already exists - left unchanged.'
}

Step 'Database tables and reference data'
Push-Location $backend
try {
    & $py manage.py migrate --noinput
    & $py manage.py init_civicai --keep-existing
    if (-not $NoSeed) {
        Step 'Demo data (real AI pipeline, about 2 minutes)'
        & $py manage.py seed_demo --reset
    }
} finally {
    Pop-Location
}

Step 'Frontend packages'
Push-Location $frontend
try {
    npm install
    if (-not (Test-Path '.env') -and (Test-Path '.env.example')) {
        Copy-Item '.env.example' '.env'
        Write-Host 'Created frontend\.env from .env.example.'
    }
} finally {
    Pop-Location
}

Write-Host "`nSetup complete. Start both servers with:  powershell -ExecutionPolicy Bypass -File .\start-dev.ps1" -ForegroundColor Cyan
Write-Host 'Demo logins: admin@civicai.local / Admin@12345, roads.officer1@civicai.local / Officer@12345, citizen@civicai.local / Citizen@12345'
