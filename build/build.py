# -*- coding: utf-8 -*-
"""一键打包 · 漫步白月光  https://www.ccava.net/

用法：
    pip install pyinstaller edge-tts pylnk3
    python build/build.py

产物：
    dist/TTS-Server.exe          单文件可执行程序
    CCAVA在线音色.zip             分发用压缩包（exe + 5 个 bat + 3 份文档）

bat 一律 GBK + CRLF：UTF-8 的 bat 配 chcp 65001 会让 cmd 算错行字节数，
中文被截断当命令执行。
"""
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DIST = os.path.join(ROOT, 'dist')
WORK = os.path.join(ROOT, '.build-tmp')
PKG = os.path.join(ROOT, 'package')
ZIP = os.path.join(ROOT, 'CCAVA在线音色.zip')
DOCS = os.path.join(ROOT, 'docs')
EXE = os.path.join(DIST, 'TTS-Server.exe')

TOOL_URL = 'https://www.ccava.net/toolbox/novel-reader.html'
HOME = 'https://www.ccava.net/'


# ------------------------------------------------------------------ exe

def build_exe():
    print('[1/3] 打包 exe')
    cmd = [sys.executable, '-m', 'PyInstaller',
           '--clean', '--noconfirm',
           '--distpath', DIST,
           '--workpath', WORK,
           'TTS-Server.spec']
    r = subprocess.run(cmd, cwd=HERE)
    if r.returncode != 0 or not os.path.exists(EXE):
        print('    打包失败')
        return False
    print('    %s  %.1f MB' % (EXE, os.path.getsize(EXE) / 1024 / 1024))
    return True


# ------------------------------------------------------------------ bat

INSTALL = r'''@echo off
setlocal
title 在线音色服务 - 安装
color 0B
set "DEST=%LOCALAPPDATA%\CCAVA-TTS"
set "SRC=%~dp0TTS-Server.exe"
set "TOOL_URL=https://www.ccava.net/toolbox/novel-reader.html"

echo.
echo   ==========================================================
echo      在线音色服务  ·  一键安装
echo      漫步白月光   https://www.ccava.net/
echo   ==========================================================
echo.

if not exist "%SRC%" (
    echo   [错误] 同目录下找不到 TTS-Server.exe
    echo          请把整个文件夹一起解压，不要单独拖出这个 bat。
    echo.
    pause
    exit /b 1
)

echo   [1/4] 安装到:  %DEST%
if not exist "%DEST%" mkdir "%DEST%" >nul 2>&1

taskkill /f /im TTS-Server.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul

copy /y "%SRC%" "%DEST%\TTS-Server.exe" >nul
if errorlevel 1 (
    echo   [错误] 复制失败。可能是文件被占用或没有权限。
    echo.
    pause
    exit /b 1
)
echo         完成。

echo.
echo   [2/4] 配置文件
if exist "%DEST%\config.json" (
    echo         已有配置，保留不动。
) else (
    copy /y "%~dp0config.example.json" "%DEST%\config.json" >nul 2>&1
    echo         已生成默认配置（只启用微软音色）。
)
copy /y "%~dp0停止服务.bat" "%DEST%\停止服务.bat" >nul 2>&1
copy /y "%~dp0开启开机自启.bat" "%DEST%\开启开机自启.bat" >nul 2>&1
copy /y "%~dp0关闭开机自启.bat" "%DEST%\关闭开机自启.bat" >nul 2>&1
copy /y "%~dp0卸载.bat" "%DEST%\卸载.bat" >nul 2>&1
copy /y "%~dp0使用说明.txt" "%DEST%\使用说明.txt" >nul 2>&1
copy /y "%~dp0README.md" "%DEST%\README.md" >nul 2>&1
copy /y "%~dp0搭建指南.md" "%DEST%\搭建指南.md" >nul 2>&1

echo.
echo         创建桌面快捷方式...
"%DEST%\TTS-Server.exe" --install-shortcut >nul 2>&1
if errorlevel 1 (
    echo         跳过。不影响使用，手动进安装目录启动即可。
) else (
    echo         桌面上已出现「在线音色服务」。
)

echo.
echo   [3/4] 开机自动启动
echo.
echo         开启后，每次开机服务会自己跑起来，不用再管它。
echo.
choice /c yn /n /m "         要开启吗？[Y/N] "
if errorlevel 2 goto NOAUTO
"%DEST%\TTS-Server.exe" --remove-autostart >nul 2>&1
"%DEST%\TTS-Server.exe" --install-autostart >nul 2>&1
echo.
echo         已设为开机自启。
goto STARTED

:NOAUTO
"%DEST%\TTS-Server.exe" --remove-autostart >nul 2>&1
echo.
echo         已跳过。以后想开，运行「开启开机自启.bat」即可。

:STARTED
echo.
echo   [4/4] 启动服务
start "" "%DEST%\TTS-Server.exe"
ping -n 7 127.0.0.1 >nul

"%DEST%\TTS-Server.exe" --status
if not errorlevel 1 goto OK

echo         换个方式再试一次...
set "VBS=%TEMP%\_ccava_tts_start.vbs"
> "%VBS%" echo CreateObject("WScript.Shell").Run """%DEST%\TTS-Server.exe"" --autostart", 0, False
wscript //nologo "%VBS%" >nul 2>&1
del /q "%VBS%" >nul 2>&1
ping -n 9 127.0.0.1 >nul

"%DEST%\TTS-Server.exe" --status
if not errorlevel 1 goto OK

echo.
echo   [警告] 服务没能启动。常见原因:
echo          1. 端口 5210 被别的软件占用
echo          2. 杀毒软件拦截了 TTS-Server.exe
echo          3. 系统策略禁止后台程序
echo.
echo          日志: %DEST%\server.log
echo.
pause
exit /b 1

:OK
echo         服务已就绪。
echo.
echo   ==========================================================
echo      安装完成
echo   ==========================================================
echo.
echo      打开工具页，语音下拉里带「（在线）」的就是新增音色。
echo.
echo      停止服务: 运行安装目录里的「停止服务.bat」
echo      完全卸载: 运行安装目录里的「卸载.bat」
echo.
echo      漫步白月光   https://www.ccava.net/
echo.

start "" "%TOOL_URL%"
echo      已为你打开工具页。若没反应，手动访问:
echo      %TOOL_URL%
echo.
pause
'''


STOP = r'''@echo off
setlocal
title 停止在线音色服务
color 0E
set "DEST=%LOCALAPPDATA%\CCAVA-TTS"

echo.
if not exist "%DEST%\TTS-Server.exe" (
    echo   还没安装过，不用停。
    echo.
    pause
    exit /b 0
)

"%DEST%\TTS-Server.exe" --status
if errorlevel 1 (
    echo   服务本来就没在运行。
    echo.
) else (
    taskkill /f /im TTS-Server.exe >nul 2>&1
    ping -n 3 127.0.0.1 >nul
    echo   服务已停止。
    echo.
    echo   提示: 如果之前开了开机自启，下次开机会自动再启动。
    echo.
)
pause
'''


AUTOSTART_ON = r'''@echo off
setlocal
title 开启开机自启 - 在线音色服务
color 0B
set "DEST=%LOCALAPPDATA%\CCAVA-TTS"

echo.
echo   ==========================================================
echo      开启开机自启  ·  漫步白月光   https://www.ccava.net/
echo   ==========================================================
echo.

if not exist "%DEST%\TTS-Server.exe" (
    echo   [错误] 还没安装。
    echo          先运行压缩包里的「一键安装.bat」。
    echo.
    pause
    exit /b 1
)

"%DEST%\TTS-Server.exe" --check-autostart
if not errorlevel 1 (
    echo   开机自启本来就是开着的，不用再设。
    echo.
    echo   想关掉就运行同目录的「关闭开机自启.bat」。
    echo.
    pause
    exit /b 0
)

echo   正在写入自启项...
"%DEST%\TTS-Server.exe" --install-autostart >nul 2>&1
"%DEST%\TTS-Server.exe" --check-autostart
if errorlevel 1 (
    echo.
    echo   [失败] 自启项没写进去，多半是安全软件拦了注册表。
    echo.
    echo   手动办法:
    echo     1. 按 Win+R，输入  shell:startup  回车
    echo     2. 在打开的文件夹里右键 - 新建 - 快捷方式
    echo     3. 目标填:  "%DEST%\TTS-Server.exe" --autostart
    echo.
    pause
    exit /b 1
)

echo   已开启。以后每次开机，服务会自己在后台跑起来。
echo.
echo   顺手启动一下...
start "" "%DEST%\TTS-Server.exe" --autostart
ping -n 6 127.0.0.1 >nul

"%DEST%\TTS-Server.exe" --status
if errorlevel 1 (
    echo   [提示] 服务没起来。可能是端口 5210 被别的软件占了。
    echo          日志在: %DEST%\server.log
) else (
    echo   服务已在运行。浏览器打开 http://127.0.0.1:5210/ 可以确认。
)
echo.
echo   漫步白月光   https://www.ccava.net/
echo.
pause
'''


AUTOSTART_OFF = r'''@echo off
setlocal
title 关闭开机自启 - 在线音色服务
color 0E
set "DEST=%LOCALAPPDATA%\CCAVA-TTS"

echo.
echo   ==========================================================
echo      关闭开机自启  ·  漫步白月光   https://www.ccava.net/
echo   ==========================================================
echo.

if not exist "%DEST%\TTS-Server.exe" (
    echo   还没安装，没有可关的自启项。
    echo.
    pause
    exit /b 0
)

"%DEST%\TTS-Server.exe" --check-autostart
if errorlevel 1 (
    echo   开机自启本来就没开，不用管。
    echo.
    pause
    exit /b 0
)

"%DEST%\TTS-Server.exe" --remove-autostart >nul 2>&1
"%DEST%\TTS-Server.exe" --check-autostart
if errorlevel 1 (
    echo   已关闭。下次开机不会再自动启动。
) else (
    echo   [失败] 自启项没删掉，多半是安全软件拦了注册表。
    echo.
    echo   手动办法: 任务管理器 - 启动应用 - 找到 CCAVA_LocalTTS - 右键禁用
)
echo.
echo   当前正在跑的服务不受影响。要停就运行「停止服务.bat」。
echo.
pause
'''


UNINSTALL = r'''@echo off
setlocal
title 卸载在线音色服务
color 0C
set "DEST=%LOCALAPPDATA%\CCAVA-TTS"

echo.
echo   ==========================================================
echo      卸载在线音色服务
echo   ==========================================================
echo.
echo      将停止服务、取消开机自启、删除桌面图标和本机文件。
echo      不影响网页本身，也不动系统里的其他语音设置。
echo.
choice /c yn /n /m "      确认卸载？[Y/N] "
if errorlevel 2 (
    echo.
    echo      已取消。
    echo.
    pause
    exit /b 0
)

taskkill /f /im TTS-Server.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul

if exist "%DEST%\TTS-Server.exe" (
    "%DEST%\TTS-Server.exe" --remove-autostart >nul 2>&1
    "%DEST%\TTS-Server.exe" --remove-shortcut >nul 2>&1
)

ping -n 2 127.0.0.1 >nul
rd /s /q "%DEST%" >nul 2>&1

echo.
if exist "%DEST%" (
    echo      部分文件没删掉，可能还在被占用。
    echo      重启电脑后再运行一次本文件即可。
) else (
    echo      已卸载干净。
)
echo.
pause
'''


def wbat(name, text):
    with open(os.path.join(PKG, name), 'w', encoding='gbk', newline='\r\n') as f:
        f.write(text)


def build_package():
    print('[2/3] 组装分发目录')
    if os.path.isdir(PKG):
        shutil.rmtree(PKG)
    os.makedirs(PKG)

    shutil.copy2(EXE, os.path.join(PKG, 'TTS-Server.exe'))
    shutil.copy2(os.path.join(ROOT, 'config.example.json'),
                 os.path.join(PKG, 'config.example.json'))
    shutil.copy2(os.path.join(DOCS, '服务端说明.md'), os.path.join(PKG, 'README.md'))
    shutil.copy2(os.path.join(DOCS, '搭建指南.md'), os.path.join(PKG, '搭建指南.md'))
    shutil.copy2(os.path.join(DOCS, '使用说明.txt'), os.path.join(PKG, '使用说明.txt'))

    wbat('一键安装.bat', INSTALL)
    wbat('停止服务.bat', STOP)
    wbat('开启开机自启.bat', AUTOSTART_ON)
    wbat('关闭开机自启.bat', AUTOSTART_OFF)
    wbat('卸载.bat', UNINSTALL)

    for name in sorted(os.listdir(PKG)):
        print('    %-20s %9d' % (name, os.path.getsize(os.path.join(PKG, name))))


def build_zip():
    print('[3/3] 打压缩包')
    if os.path.exists(ZIP):
        os.remove(ZIP)
    with zipfile.ZipFile(ZIP, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in sorted(os.listdir(PKG)):
            z.write(os.path.join(PKG, name), 'CCAVA在线音色/' + name)
    print('    %s  %.1f MB' % (ZIP, os.path.getsize(ZIP) / 1024 / 1024))


def main():
    if not build_exe():
        return 1
    build_package()
    build_zip()
    print('\n完成。分发压缩包在: %s' % ZIP)
    print('工具页: %s' % TOOL_URL)
    return 0


if __name__ == '__main__':
    sys.exit(main())
