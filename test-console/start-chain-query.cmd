@echo off
rem Starts chain-query (read-only chain queries for the console's "Blockchain queries" twisty) on 127.0.0.1:8750.
rem It holds no keys, signs nothing and calls no model. Keep this window open. Extra flags are passed on, for example:
rem   start-chain-query.cmd --port 8751 --timeout-ms 15000
cd /d "%~dp0..\services\chain-query" || (echo services\chain-query not found & exit /b 1)
node src\main.ts %*
