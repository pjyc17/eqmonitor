@echo off
chcp 65001 >nul 2>&1
echo.
echo   서버 재시작 중...
echo.
pm2 delete equipment-monitor >nul 2>&1
pm2 start ecosystem.config.js
echo.
pm2 status
echo.
pause
