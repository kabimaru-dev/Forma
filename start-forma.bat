@echo off
cd /d "%~dp0"
node script/launch.mjs
if errorlevel 1 pause
