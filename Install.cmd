@echo off
chcp 65001 >nul
title Linli Local Mail - Install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" %*
pause
