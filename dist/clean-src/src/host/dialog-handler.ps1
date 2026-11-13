<#
  dialog-handler.ps1 -- scan / dismiss native Photoshop modals from the host side.

  WHY THIS LIVES OUTSIDE THE JSX:
  When a native modal is up, Photoshop's main window is disabled and the JSX thread
  that DoJavaScript is executing on is the one blocked. So the modal CANNOT be handled
  from inside the extension -- only from a separate host process. That is why this is a
  host-side tool (kind: 'node' in catalog.mjs), not an engine op.

  WHAT IT DOES:
    -Action scan    list every visible Photoshop dialog: class, title, child buttons
    -Action handle  press a button on each visible dialog, per -Policy

  BUTTON SELECTION (revised after three measured defects):
  Child buttons are enumerated and clicked BY HANDLE, not by a fixed control ID.
    - exactly 1 button           -> press it (any policy). Single-button alerts only have
                                    one button; pressing nothing used to stall for 67s.
    - 2+ buttons, policy=ok      -> press the FIRST button
    - 2+ buttons, policy=cancel  -> press the LAST button (Cancel is conventionally last)
    - 2+ buttons, policy=auto    -> LAST button (cancel) as well
  Output records button_index / button_count / button_text so the choice is auditable.
  The earlier version used GetDlgItem(IDOK/IDCANCEL); Photoshop's three-button rasterize
  prompt does not use those IDs, so every policy silently degraded to WM_CLOSE.

  WHY auto CANCELS SAVE DIALOGS (measured):
  A save dialog only appears when the programmatic path was unusable. Pressing "OK"
  there makes the COM call return ok:true while NOTHING is written to the requested
  path -- a silent fake success (verified: no artifact anywhere on disk). Cancelling is
  the honest outcome and still releases the COM call. Use policy=ok only when a caller
  explicitly wants the interactive default location.

  OUTPUT: one JSON line on stdout.
  PURE ASCII REQUIRED: PowerShell 5.1 decodes .ps1 as the system ANSI codepage (GBK on
  zh-CN); a non-ASCII literal here breaks parsing silently.
#>
param(
    [ValidateSet('scan', 'handle')]
    [string]$Action = 'scan',
    [ValidateSet('auto', 'ok', 'cancel')]
    [string]$Policy = 'auto'
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PsDlgHost {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@

$BM_CLICK = 0x00F5
$WM_CLOSE = 0x0010

function Get-WinText([IntPtr]$h) {
    $len = [PsDlgHost]::GetWindowTextLength($h)
    if ($len -le 0) { return '' }
    $sb = New-Object System.Text.StringBuilder ($len + 2)
    [void][PsDlgHost]::GetWindowText($h, $sb, $sb.Capacity)
    return $sb.ToString()
}

function Get-WinClass([IntPtr]$h) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][PsDlgHost]::GetClassName($h, $sb, 256)
    return $sb.ToString()
}

function Get-ChildButtons([IntPtr]$h) {
    $list = New-Object System.Collections.ArrayList
    $cb = [PsDlgHost+EnumWindowsProc]{
        param($c, $l)
        $cls = Get-WinClass $c
        if ($cls -match 'Button') {
            $id = [PsDlgHost]::GetDlgCtrlID($c)
            $t = Get-WinText $c
            if ($t -ne '') {
                [void]$list.Add([pscustomobject]@{ hwnd = $c; ctrlId = $id; text = $t })
            }
        }
        return $true
    }
    [void][PsDlgHost]::EnumChildWindows($h, $cb, [IntPtr]::Zero)
    return $list
}

# Match buttons by CAPTION, not by position. Position fallback failed in practice:
# the real "save a copy" sheet has 10 buttons and the LAST one is "Help", not "Cancel";
# pressing the last button opened Help and the sheet stayed up.
# Captions must stay pure ASCII here: build CJK text from char codes, because
# PowerShell 5.1 decodes .ps1 as the system ANSI codepage (GBK) and a CJK literal
# in this file breaks parsing. (Verified: one CJK comment line was enough to corrupt it.)
$T_CANCEL = [string]([char]0x53D6) + [char]0x6D88                        # Cancel
$T_OK     = [string]([char]0x786E) + [char]0x5B9A                        # OK
$T_SMART  = [string]([char]0x8F6C) + [char]0x6362 + [char]0x4E3A        # Convert-to-...

function Find-ButtonIndex($buttons, [string]$needle) {
    for ($i = 0; $i -lt $buttons.Count; $i++) {
        if ($buttons[$i].text -like ('*' + $needle + '*')) { return $i }
    }
    return -1
}

function Resolve-Choice {
    param([string]$Policy, $Buttons)
    $n = $Buttons.Count
    if ($n -le 0) { return @{ Index = -1; Why = 'no-button' } }
    $cancelIdx = Find-ButtonIndex $Buttons $T_CANCEL
    $okIdx = Find-ButtonIndex $Buttons $T_OK
    if ($Policy -eq 'ok') {
        $smartIdx = Find-ButtonIndex $Buttons $T_SMART
        if ($smartIdx -ge 0) { return @{ Index = $smartIdx; Why = 'policy=ok: matched convert-to-smart-object' } }
        if ($okIdx -ge 0) { return @{ Index = $okIdx; Why = 'policy=ok: matched OK caption' } }
        return @{ Index = 0; Why = 'policy=ok: first button (no OK caption found)' }
    }
    if ($cancelIdx -ge 0) {
        return @{ Index = $cancelIdx; Why = ('matched cancel caption at index {0} of {1}' -f $cancelIdx, $n) }
    }
    if ($n -eq 1) { return @{ Index = 0; Why = 'single-button: no cancel caption, press it' } }
    return @{ Index = -1; Why = 'no cancel caption: fall back to WM_CLOSE' }
}

$psProcs = @(Get-Process Photoshop -ErrorAction SilentlyContinue)
$result = [ordered]@{
    ok                = $true
    action            = $Action
    policy            = $Policy
    photoshop_running = ($psProcs.Count -gt 0)
    photoshop_pids    = @($psProcs | ForEach-Object { $_.Id })
    dialogs           = @()
    handled           = @()
    warnings          = @()
}

if ($psProcs.Count -eq 0) {
    ($result | ConvertTo-Json -Depth 8 -Compress)
    exit 0
}

$psIds = @($psProcs | ForEach-Object { $_.Id })
$tops = New-Object System.Collections.ArrayList
$cbTop = [PsDlgHost+EnumWindowsProc]{
    param($h, $l)
    $p = 0
    [void][PsDlgHost]::GetWindowThreadProcessId($h, [ref]$p)
    if ($psIds -contains $p) { [void]$tops.Add($h) }
    return $true
}
[void][PsDlgHost]::EnumWindows($cbTop, [IntPtr]::Zero)

$dialogs = @()
$handled = @()
$warnings = @()

foreach ($h in $tops) {
    $cls = Get-WinClass $h
    if (-not ($cls -eq '#32770' -or $cls -eq 'PSDialogBox')) { continue }
    if (-not [PsDlgHost]::IsWindowVisible($h)) { continue }
    $title = Get-WinText $h
    $buttons = @(Get-ChildButtons $h)

    # Capture the dialog BODY: every child control that carries text (static text,
    # edit boxes...). Read-only, no behaviour change; the body is the native
    # Photoshop error description, which is what tells a human what actually failed.
    $bodyParts = New-Object System.Collections.ArrayList
    $cbText = [PsDlgHost+EnumWindowsProc]{
        param($c, $l)
        $t = Get-WinText $c
        if ($t -ne '') { [void]$bodyParts.Add($t) }
        return $true
    }
    [void][PsDlgHost]::EnumChildWindows($h, $cbText, [IntPtr]::Zero)
    $bodyText = ($bodyParts -join ' | ')

    $dialogs += [pscustomobject][ordered]@{
        class        = $cls
        title        = $title
        text         = $bodyText
        enabled      = [PsDlgHost]::IsWindowEnabled($h)
        button_count = $buttons.Count
        buttons      = @($buttons | ForEach-Object { $_.text })
    }

    if ($Action -eq 'handle') {
        $choice = Resolve-Choice -Policy $Policy -Buttons $buttons
        $method = 'none'
        $pickedText = ''
        $pickedIndex = $choice.Index
        if ($choice.Index -ge 0) {
            $btn = $buttons[$choice.Index]
            $pickedText = $btn.text
            if ([PsDlgHost]::PostMessage($btn.hwnd, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)) {
                $method = 'BM_CLICK'
            }
        }
        if ($method -eq 'none') {
            if ([PsDlgHost]::PostMessage($h, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)) {
                $method = 'WM_CLOSE'
                $pickedText = ''
                $pickedIndex = -1
            }
        }
        if ($cls -eq '#32770' -and $Policy -eq 'auto') {
            $warnings += ('save-dialog cancelled by auto: pressing OK here reports ok without writing the requested path ({0})' -f $title)
        }
        $handled += [pscustomobject][ordered]@{
            title        = $title
            class        = $cls
            method       = $method
            button_index = $pickedIndex
            button_count = $buttons.Count
            button_text  = $pickedText
            why          = $choice.Why
        }
    }
}

$result.dialogs = @($dialogs)
$result.handled = @($handled)
$result.warnings = @($warnings)
($result | ConvertTo-Json -Depth 8 -Compress)
exit 0
