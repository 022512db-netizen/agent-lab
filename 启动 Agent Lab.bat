@echo off
REM Double-click to start Agent Lab (desktop window, runs in background).
REM Log: launch.log. To watch it live, run: node start.mjs
REM
REM ASCII-only, and deliberately no "cd": this project lives under a path with
REM non-ASCII characters, and "cd /d <that path>" fails under the GBK codepage
REM with "The filename, directory name, or volume label syntax is incorrect".
REM A failing cd does not stop a batch file, so wscript below never ran and it
REM looked like double-clicking did nothing. The .vbs sets its own working
REM directory through COM instead, so it does not need us to cd first.
setlocal
wscript //nologo "%~dp0start-silent.vbs"
endlocal
