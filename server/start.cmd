@echo off
rem Starts the Shironet lyrics server in this console. Ctrl+C or closing the window stops it
rem cleanly: the browser closes and its profile is deleted.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 26) { console.error('Node 26 or later is needed; this is ' + process.version); process.exit(1); }" || exit /b 1
if not exist node_modules (
  echo Run "npm ci" in %~dp0 first.
  exit /b 1
)
node src\cli.ts serve
