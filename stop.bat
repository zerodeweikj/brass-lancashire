@echo off
chcp 65001 >nul
echo ============================================================
echo   停止 Brass: Lancashire 服务器（端口 8765）
echo ============================================================
echo.

powershell -NoProfile -Command ^
  "$conns = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue; ^
   if ($conns) { ^
     $conns | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host ('  已停止进程 PID=' + $_.OwningProcess) }; ^
     Write-Host '  服务已停止。' ^
   } else { ^
     Write-Host '  端口 8765 当前没有运行中的服务。' ^
   }"

echo.
pause
