@echo off
cd /d "%~dp0"
if exist "..\.venv\Scripts\python.exe" (
  "..\.venv\Scripts\python.exe" apps\desktop\main.py
) else (
  python apps\desktop\main.py
)
