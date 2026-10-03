<#
.SYNOPSIS
  Starts the whole Ghost AI stack for local development.

.DESCRIPTION
  Three services, each in its own window so logs stay readable:

    db        Postgres on host port 55432 (Docker)
    api       FastAPI on port 8000
    web       Next.js on port 3000

  The web app talks to the API; the API talks to Postgres. Any of them can be
  started on its own -- see README.md.

.PARAMETER Detach
  Run in the current window instead of new windows. Ctrl+C stops everything.

.EXAMPLE
  ./dev.ps1
  ./dev.ps1 -Detach
#>
[CmdletBinding()]
param(
  [switch]$Detach
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath

function Start-Step {
  param([string]$Name, [string]$Dir, [string]$Command)

  Write-Host "Starting $Name in $Dir" -ForegroundColor Cyan
  Push-Location $Dir
  try {
    if ($Detach) {
      Invoke-Expression $Command
    } else {
      # New window so each service gets its own scrollback and can be closed
      # independently without taking the others down.
      $proc = Start-Process -FilePath 'cmd.exe' -PassThru -ArgumentList '/k', $Command
      Write-Host "  $Name -> pid $($proc.Id)" -ForegroundColor DarkGray
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path (Join-Path $root 'api\.venv\Scripts\python.exe'))) {
  Write-Warning "backend/.venv is missing. Create it first:"
  Write-Warning "  cd api; uv venv; uv pip install -e '.[dev]'"
}

if (-not (Test-Path (Join-Path $root 'ghost\node_modules'))) {
  Write-Warning "frontend/node_modules is missing. Run 'npm install' in frontend/ first."
}

Start-Step -Name 'db'  -Dir $root       -Command 'docker compose up -d db'
Start-Step -Name 'api' -Dir (Join-Path $root 'api')  -Command '.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000 --reload'
Start-Step -Name 'web' -Dir (Join-Path $root 'ghost') -Command 'npm run dev'

Write-Host ''
Write-Host '  web  http://localhost:3000' -ForegroundColor Green
Write-Host '  api  http://localhost:8000/docs' -ForegroundColor Green
Write-Host '  db   postgresql://ghost:ghost@localhost:55432/ghost' -ForegroundColor Green
Write-Host ''

if ($Detach) { Write-Host 'Ctrl+C to stop.' -ForegroundColor Yellow }