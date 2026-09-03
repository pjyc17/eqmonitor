@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

echo.
echo  ══════════════════════════════════════════════
echo   설비 모니터링 서버 설치/실행
echo  ══════════════════════════════════════════════
echo.

:: 현재 폴더를 작업 디렉토리로 사용
set "APP_DIR=%~dp0"
set "APP_DIR=%APP_DIR:~0,-1%"
cd /d "%APP_DIR%"

:: ── 1. Node.js 확인 ──
echo  [1/5] Node.js 확인 중...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ✘ Node.js가 설치되어 있지 않습니다.
    echo    https://nodejs.org 에서 LTS 버전을 설치한 후 다시 실행하세요.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set "NODE_VER=%%v"
echo    Node.js %NODE_VER% 확인됨

:: ── 2. npm install ──
echo.
echo  [2/5] 패키지 설치 중... (npm install)
if not exist "node_modules" (
    call npm install --production
    if %errorlevel% neq 0 (
        echo  ✘ npm install 실패
        pause
        exit /b 1
    )
    echo    패키지 설치 완료
) else (
    echo    node_modules 이미 존재 — 건너뜀
)

:: ── 3. PM2 설치 ──
echo.
echo  [3/5] PM2 확인 중...
where pm2 >nul 2>&1
if %errorlevel% neq 0 (
    echo    PM2 설치 중...
    call npm install -g pm2
    if %errorlevel% neq 0 (
        echo  ✘ PM2 설치 실패
        pause
        exit /b 1
    )
)
echo    PM2 확인됨

:: ── 4. ecosystem.config.js 경로 자동 수정 ──
echo.
echo  [4/5] PM2 설정 업데이트...

:: ecosystem.config.js의 cwd를 현재 폴더로 자동 변경
set "ESC_DIR=%APP_DIR:\=\\%"
>"%APP_DIR%\ecosystem.config.js" (
    echo module.exports = {
    echo   apps: [{
    echo     name: 'equipment-monitor',
    echo     script: 'server.js',
    echo     cwd: '%ESC_DIR%',
    echo     watch: false,
    echo     max_restarts: 10,
    echo     restart_delay: 3000,
    echo     env: {
    echo       NODE_ENV: 'production'
    echo     }
    echo   }]
    echo };
)
echo    cwd: %APP_DIR%

:: ── 5. PM2 시작 ──
echo.
echo  [5/5] 서버 시작 중...

:: 기존 프로세스 정리
pm2 delete equipment-monitor >nul 2>&1
pm2 start ecosystem.config.js
pm2 save

:: PM2 경로 찾기 (자동시작 bat용)
for /f "tokens=*" %%p in ('where pm2') do set "PM2_PATH=%%p"

:: 자동시작 bat 생성
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "BAT_FILE=%STARTUP_DIR%\pm2-resurrect.bat"
>"%BAT_FILE%" (
    echo @echo off
    echo timeout /t 15 /nobreak ^>nul
    echo "%PM2_PATH%" resurrect
)
echo    자동시작 등록: %BAT_FILE%

:: ── 완료 ──
echo.
echo  ══════════════════════════════════════════════
echo   설치 완료!
echo  ══════════════════════════════════════════════
echo.

:: IP 주소 표시
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set "IP=%%a"
    set "IP=!IP: =!"
    echo   PC:       https://localhost:3443
    echo   네트워크: https://!IP!:3443
    goto :done_ip
)
:done_ip

echo.
echo   * 처음 접속 시 "안전하지 않음" 경고 → "계속 진행" 클릭
echo   * 서버 중지: pm2 stop equipment-monitor
echo   * 서버 로그: pm2 logs equipment-monitor
echo.
pause
