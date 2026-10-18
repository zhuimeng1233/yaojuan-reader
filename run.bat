@echo off
title Yaojuan
echo ========================================================
echo   Starting Yaojuan Server...
echo ========================================================
echo.

cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Python is not found in your PATH. Please install Python 3.10+ and try again.
    pause
    exit /b 1
)

python -c "import fastapi, uvicorn, psutil, websockets" >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Installing Python dependencies...
    python -m pip install -r requirements.txt
    if %errorlevel% neq 0 (
        echo [ERROR] Dependency installation failed.
        pause
        exit /b 1
    )
)

python server.py
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server exited with error code %errorlevel%.
    pause
)
