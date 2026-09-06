@echo off
setlocal enabledelayedexpansion
title Machine Breakdown Tracker
cd /d "%~dp0"

echo ============================================================
echo   Machine Breakdown Tracker - Setup ^& Run
echo ============================================================
echo.

REM ---- 1. Find a working Python (tries "python" then the "py" launcher) --
set PYEXE=
where python >nul 2>nul
if not errorlevel 1 (
    python --version >nul 2>nul
    if not errorlevel 1 set PYEXE=python
)
if "%PYEXE%"=="" (
    where py >nul 2>nul
    if not errorlevel 1 set PYEXE=py
)

if "%PYEXE%"=="" (
    echo [ERROR] Python was not found.
    echo.
    echo Please install Python first: https://www.python.org/downloads/
    echo During installation, make sure to check "Add Python to PATH".
    echo.
    pause
    exit /b 1
)

for /f "tokens=2" %%v in ('%PYEXE% --version 2^>^&1') do set PYVER=%%v
echo [OK] Python found (version %PYVER%)
echo.

REM ---- 2. Create a virtual environment (keeps things clean/isolated) ----
if not exist "venv\Scripts\python.exe" (
    echo [SETUP] Creating virtual environment ^(first run only^)...
    %PYEXE% -m venv venv
    if errorlevel 1 (
        echo [ERROR] Could not create the virtual environment.
        pause
        exit /b 1
    )
) else (
    echo [OK] Virtual environment already exists.
)
echo.

set VENV_PY=venv\Scripts\python.exe

REM ---- 3. Install/upgrade requirements -----------------------------------
echo [SETUP] Installing requirements, please wait...
"%VENV_PY%" -m pip install --upgrade pip >nul
"%VENV_PY%" -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo [ERROR] Requirements could not be installed. Check the error above,
    echo         your internet connection, or the requirements.txt file.
    pause
    exit /b 1
)
echo.
echo [OK] All requirements installed ^(including the waitress production server^).
echo.

REM ---- 4. Run the app, with auto-restart if it ever crashes --------------
echo ============================================================
echo   Starting the app (24/7 mode - will auto-restart if it crashes)
echo   Open this link in your browser: http://localhost:5115
echo   From another device on this network: http://[this-PC-IP]:5115
echo   Logs: data\app.log
echo   Close this window to shut the app down completely.
echo ============================================================
echo.

:runloop
"%VENV_PY%" app.py
echo.
echo [%date% %time%] The app has stopped. Restarting in 5 seconds...
echo (Close this window now to shut it down completely.)
timeout /t 5 /nobreak >nul
goto runloop
