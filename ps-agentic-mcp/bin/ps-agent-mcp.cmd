@echo off
rem ps-agent MCP server launcher.
rem Pure ASCII on purpose: cmd.exe reads .cmd with the OEM codepage, so any
rem non-ASCII literal here would be mangled on zh-CN machines.
setlocal

set "ROOT=%~dp0.."
if not exist "%ROOT%\src\mcp\server.mjs" (
  echo [ps-agent] server.mjs not found under %ROOT% 1>&2
  exit /b 1
)

rem Prefer node from PATH. If the host launches us with a minimal child
rem environment, point PS_AGENT_NODE at an absolute node.exe first.
set "NODE_BIN="
for %%I in (node.exe) do if not defined NODE_BIN set "NODE_BIN=%%~$PATH:I"
if not defined NODE_BIN if defined PS_AGENT_NODE set "NODE_BIN=%PS_AGENT_NODE%"
if not exist "%NODE_BIN%" (
  echo [ps-agent] node.exe not found. Install Node 20+ or set PS_AGENT_NODE. 1>&2
  exit /b 1
)

"%NODE_BIN%" "%ROOT%\src\mcp\server.mjs" %*
exit /b %ERRORLEVEL%
