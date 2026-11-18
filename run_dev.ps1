# Starts the backend (port 8000) and the frontend dev server (port 5173) in two windows.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $root "backend\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) { Write-Error "Backend virtualenv missing. See README.md 'first time only'."; exit 1 }
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend'; & '$py' -m uvicorn app.main:app --reload --reload-dir app --port 8000"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; npm run dev"
Write-Host "Backend: http://localhost:8000/docs   Frontend: http://localhost:5173"
