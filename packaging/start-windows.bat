@echo off
chcp 65001 >nul
title QA Flow Hub
cd /d "%~dp0"
REM Bam dup de mo QA Flow Hub. Dong cua so nay de tat.
runtime\node.exe launcher.mjs
pause
