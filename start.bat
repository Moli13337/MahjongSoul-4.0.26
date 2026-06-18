@echo off
chcp 65001 >nul 2>&1
title MahjongSoul Private Server Launcher
color 0A

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║     MahjongSoul Private Server - One-Click Launcher   ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

:: ==========================================
:: Configuration - Edit these paths if needed
:: ==========================================

:: Game directory (contains Jantama_MahjongSoul.exe and GameAssembly.dll)
set "GAME_DIR=%~dp0..\game"

:: If game dir doesn't exist relative to script, ask user
if not exist "%GAME_DIR%\Jantama_MahjongSoul.exe" (
    set /p "GAME_DIR=Enter game directory path: "
)

:: Server directory
set "SERVER_DIR=%~dp0server"

:: Proxy script
set "PROXY_SCRIPT=%~dp0patch\local_proxy.py"

:: ==========================================
:: Step 1: Check prerequisites
:: ==========================================

echo  [1/5] Checking prerequisites...

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python not found! Please install Python 3.8+
    pause
    exit /b 1
)
echo        Python: OK

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js not found! Please install Node.js 18+
    pause
    exit /b 1
)
echo        Node.js: OK

:: Check game executable
if not exist "%GAME_DIR%\Jantama_MahjongSoul.exe" (
    echo  [ERROR] Game executable not found: %GAME_DIR%\Jantama_MahjongSoul.exe
    pause
    exit /b 1
)
echo        Game: OK

:: Check if server is built
if not exist "%SERVER_DIR%\dist\index.js" (
    echo.
    echo  [INFO] Server not built. Building now...
    cd /d "%SERVER_DIR%"
    
    if not exist "node_modules" (
        echo  [INFO] Installing dependencies...
        call npm install
        if errorlevel 1 (
            echo  [ERROR] npm install failed!
            pause
            exit /b 1
        )
    )
    
    echo  [INFO] Compiling TypeScript...
    call npm run build
    if errorlevel 1 (
        echo  [ERROR] Build failed!
        pause
        exit /b 1
    )
    echo  [OK] Server built successfully!
)

echo.

:: ==========================================
:: Step 2: Check/patch hosts file
:: ==========================================

echo  [2/5] Checking hosts file...

:: Check admin privileges
net session >nul 2>&1
if errorlevel 1 (
    echo  [WARN] Not running as Administrator - hosts file may not be patched
    echo  [WARN] If the game cannot connect, run this script as Administrator
    goto :skip_hosts
)

set "HOSTS_FILE=C:\Windows\System32\drivers\etc\hosts"
set "HOSTS_BACKUP=%HOSTS_FILE%.bak.mahjongsoul"

:: Backup hosts file
if not exist "%HOSTS_BACKUP%" (
    copy "%HOSTS_FILE%" "%HOSTS_BACKUP%" >nul
    echo        Hosts backup created
)

:: Check if already patched
findstr /C:"mjusgs.mahjongsoul.com" "%HOSTS_FILE%" >nul 2>&1
if not errorlevel 1 (
    echo        Hosts already patched
    goto :skip_hosts
)

:: Add entries
echo. >> "%HOSTS_FILE%"
echo # MahjongSoul Private Server - DO NOT EDIT >> "%HOSTS_FILE%"
echo 127.0.0.1  mjusgs.mahjongsoul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  game.mahjongsoul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  game.maj-soul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  route-2.maj-soul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  route-3.maj-soul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  route-4.maj-soul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  route-5.maj-soul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  route-6.maj-soul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  www.maj-soul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  common-202411.maj-soul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  record-old.maj-soul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  contest-gate-202411.maj-soul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  app-update-1.catmajsoul.com >> "%HOSTS_FILE%"
echo 127.0.0.1  app-update-1.catmjstudio.com >> "%HOSTS_FILE%"
echo 127.0.0.1  app-update-2.catmjstudio.com >> "%HOSTS_FILE%"
echo # End MahjongSoul Private Server >> "%HOSTS_FILE%"

echo        15 domain redirects added

:skip_hosts
echo.

:: ==========================================
:: Step 3: Start local proxy
:: ==========================================

echo  [3/5] Starting local proxy...
start "MahjongSoul Proxy" /MIN python "%PROXY_SCRIPT%"
timeout /t 2 /nobreak >nul
echo        Proxy started (minimized)

:: ==========================================
:: Step 4: Start private server
:: ==========================================

echo  [4/5] Starting private server...
cd /d "%SERVER_DIR%"
start "MahjongSoul Server" /MIN cmd /c "node dist/index.js"
timeout /t 3 /nobreak >nul
echo        Server started (minimized)

:: ==========================================
:: Step 5: Launch game
:: ==========================================

echo  [5/5] Launching game...
cd /d "%GAME_DIR%"
start "" "Jantama_MahjongSoul.exe"
echo        Game launched!

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║  All services started!                                ║
echo  ║                                                       ║
echo  ║  Proxy:  Running (minimized window)                   ║
echo  ║  Server: Running (minimized window)                   ║
echo  ║  Game:   Launched                                     ║
echo  ║                                                       ║
echo  ║  To stop: Close all minimized windows                 ║
echo  ╚══════════════════════════════════════════════════════╝
echo.
pause
