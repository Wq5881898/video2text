@echo off
cd /d "%~dp0"
set "PYTHONPATH=%~dp0;%PYTHONPATH%"
if exist "..\.venv\Scripts\python.exe" (
  "..\.venv\Scripts\python.exe" apps\desktop\main.py
) else (
  python apps\desktop\main.py
)
