<#
  ps-worker.ps1 -- COM driver for Adobe Photoshop (Windows only).

  IMPORTANT: this file is deliberately PURE ASCII.
  PowerShell 5.1 decodes .ps1 files as the system ANSI codepage (GBK on zh-CN
  machines), so any non-ASCII literal breaks parsing with cryptic errors.
  Chinese guidance for humans lives in ../host/README.md instead.

  Protocol: read ONE line of JSON on stdin, write ONE line of JSON on stdout.
    { "kind": "engine|core|semantic", "op": "status", "expr": "...", "args": {...} }

  Exit codes: 0 ok, 1 bad request/internal, 2 no Photoshop COM, 3 empty result.
#>
param()

$ErrorActionPreference = 'Stop'
# stdin carries UTF-8 from Node. PowerShell 5.1 decodes redirected stdin with the
# console INPUT codepage (GBK on zh-CN), so every non-ASCII argument (Chinese layer
# names, text contents, file paths) was corrupted BEFORE reaching Photoshop.
# OutputEncoding alone is not enough: it only covers what we write back.
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Result($obj) {
    ($obj | ConvertTo-Json -Depth 40 -Compress) | ForEach-Object { [Console]::Out.WriteLine($_) }
}

function Escape-JsString([string]$s) {
    $s = $s -replace '\\', '\\\\'
    $s = $s -replace '"', '\"'
    $s = $s -replace "`r", '\r'
    $s = $s -replace "`n", '\n'
    $s = $s -replace "`t", '\t'
    return '"' + $s + '"'
}

$requestFile = $null

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) {
        Write-Result @{ ok = $false; error = 'empty_stdin'; message = 'Expected one line of JSON on stdin.' }
        exit 1
    }
    $req = $raw | ConvertFrom-Json

    # src/host -> src -> repo root
    $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $enginePath = Join-Path $root 'src/engine/anime_engine.jsx'
    $corePath   = Join-Path $root 'src/engine/ps_core.jsx'
    if (-not (Test-Path $enginePath)) {
        Write-Result @{ ok = $false; error = 'engine_not_found'; message = "Missing $enginePath" }
        exit 1
    }

    $workDir = Join-Path $env:TEMP 'psx-work'
    if (-not (Test-Path $workDir)) { New-Item -ItemType Directory -Force -Path $workDir | Out-Null }

    try {
        $ps = New-Object -ComObject Photoshop.Application
    }
    catch {
        Write-Result @{
            ok      = $false
            error   = 'photoshop_not_available'
            message = 'Photoshop COM (Photoshop.Application) is not registered on this machine.'
            hint    = 'Install desktop Photoshop 26+ , or use --backend mock for offline work.'
        }
        exit 2
    }

    $kind = if ($req.kind) { $req.kind } else { 'engine' }
    $argsJson = if ($null -ne $req.args) { $req.args | ConvertTo-Json -Depth 40 -Compress } else { '{}' }
    if ([string]::IsNullOrWhiteSpace($argsJson)) { $argsJson = '{}' }

    if ($kind -eq 'engine') {
        $requestFile = Join-Path $workDir ('req-' + [guid]::NewGuid().ToString('N') + '.json')
        $payload = [ordered]@{
            operation   = $req.op
            args        = $req.args
            cancel_file = (Join-Path $workDir 'cancel.flag')
            deadline    = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 300000
        } | ConvertTo-Json -Depth 40 -Compress
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($requestFile, $payload, $utf8NoBom)

        $engineSrc = [System.IO.File]::ReadAllText($enginePath, [System.Text.Encoding]::UTF8)
        $code = 'var DSH_REQUEST_FILE = ' + (Escape-JsString $requestFile) + ';' + "`n" + $engineSrc
    }
    else {
        $extPath = Join-Path $root 'src/engine/ext.jsx'
        $serPath = Join-Path $root 'src/engine/serialize.jsx'
        $coreSrc = [System.IO.File]::ReadAllText($corePath, [System.Text.Encoding]::UTF8)
        $extSrc  = [System.IO.File]::ReadAllText($extPath, [System.Text.Encoding]::UTF8)
        $serSrc  = [System.IO.File]::ReadAllText($serPath,  [System.Text.Encoding]::UTF8)
        $expr = if ($req.expr) { $req.expr } else { 'undefined' }
        # Document anchoring: most core/semantic ops act on app.activeDocument and
        # ignore the document_id argument, so with several documents open a call can
        # land on the WRONG document. Resolve it here, inside the SAME DoJavaScript:
        # Photoshop runs one script at a time, so "activate then operate" is atomic
        # with respect to every other caller.
        $anchor = 'if (a.document_id !== undefined && a.document_id !== null) {' +
                  ' var __ds = app.documents; var __hit = null;' +
                  ' for (var __i = 0; __i < __ds.length; __i++) {' +
                  '  if (__ds[__i].id === a.document_id) { __hit = __ds[__i]; break; } }' +
                  ' if (__hit) { app.activeDocument = __hit; } };'
        $code = $coreSrc + "`n" + $extSrc + "`n" + $serSrc + "`n" + ';(function(){ var a = ' + $argsJson + ';' + $anchor + ' var r = (' + $expr + ');' +
                ' return __PSX.safe(typeof r === "undefined" ? "ok" : r); }());'
    }

    # 3 = DoNotDisplayDialogs, so the script never blocks on a native modal.
    $result = $ps.DoJavaScript($code, $null, 3)

    if ($null -eq $result -or [string]::IsNullOrWhiteSpace([string]$result)) {
        Write-Result @{ ok = $false; error = 'empty_result'; message = 'DoJavaScript returned nothing.' }
        exit 3
    }
    # engine already returns JSON text; pass through without double-encoding.
    [Console]::Out.WriteLine($result)
    exit 0
}
catch {
    Write-Result @{ ok = $false; error = 'worker_exception'; message = $_.Exception.Message }
    exit 1
}
finally {
    if ($requestFile -and (Test-Path $requestFile)) {
        try { Remove-Item -LiteralPath $requestFile -Force } catch { }
    }
}

<#
  TODO (expected saving 500-900ms per call, measure after PS is installed)
  -------------------------------------------------------------------------
  1. Resident mode: keep the process alive, DoJavaScript the engine ONCE at
     startup, then send only the request file path per call. Requires turning
     engine.jsx into "define run(requestPath)" without self-executing.
  2. Batch mode: run the whole ops array inside one DoJavaScript call to avoid
     N COM round-trips. This is where layer-level commands actually pay off.
#>
