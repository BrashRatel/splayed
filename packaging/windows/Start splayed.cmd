@echo off
rem Starts splayed's web UI and opens it in your browser. Closing this window stops splayed.
cd /d "%~dp0"
if not exist "%~dp0splayed.exe" (
  echo splayed.exe is not next to this file. Keep everything from the zip together in one folder.
  echo.
  pause
  exit /b 1
)
echo Starting splayed. Your browser should open in a moment.
echo Keep this window open while you use splayed; close it to stop.
echo.
"%~dp0splayed.exe" ui --open
echo.
echo splayed has stopped. Press any key to close this window.
pause >nul
