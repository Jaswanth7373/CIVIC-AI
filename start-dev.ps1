<#
.SYNOPSIS
  Start the CivicAI development servers in two new PowerShell windows:
    backend   http://localhost:8000   (Django REST API + Django admin at /admin/)
    frontend  http://localhost:5173   (React app)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\start-dev.ps1
#>
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$py = Join-Path $backend 'venv\Scripts\python.exe'

if (-not (Test-Path $py)) {
    Write-Host 'backend\venv not found - run .\setup.ps1 first.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $frontend 'node_modules'))) {
    Write-Host 'frontend\node_modules not found - run .\setup.ps1 first.' -ForegroundColor Red
    exit 1
}

Start-Process powershell -WorkingDirectory $backend -ArgumentList @(
    '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'CivicAI API :8000'; & '$py' manage.py runserver 0.0.0.0:8000"
)
Start-Process powershell -WorkingDirectory $frontend -ArgumentList @(
    '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'CivicAI web :5173'; npm run dev"
)

Write-Host 'Starting servers...'
Write-Host '  API       http://localhost:8000/api/health/'
Write-Host '  Web app   http://localhost:5173'
Write-Host '  Admin     http://localhost:8000/admin/'
Write-Host 'Demo logins: admin@civicai.local / Admin@12345, roads.officer1@civicai.local / Officer@12345, citizen@civicai.local / Citizen@12345'
