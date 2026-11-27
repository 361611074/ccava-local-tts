# -*- coding: utf-8 -*-
"""
在线音色本地服务  ·  漫步白月光  https://www.ccava.net/

浏览器自带的 speechSynthesis 只能读系统 SAPI5 音色，Windows 中文通常只有 1~4 个。
本服务在本机起一个 HTTP 接口，把微软 Edge 的在线语音合成接到网页里，
让朗读音色从个位数变成十几个。

引擎：edge  微软 Edge 朗读通道，免费、免密钥、14 个中文音色。

只监听 127.0.0.1，不对外暴露。
"""

import asyncio
import json
import os
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import edge_tts

APP_NAME = 'CCAVA_LocalTTS'
RUN_KEY = r'Software\Microsoft\Windows\CurrentVersion\Run'
HOST = '127.0.0.1'
PORT = 5210
MAX_TEXT = 1200
VOICE_CACHE_TTL = 3600
SYNTH_TIMEOUT = 45
HOME = 'https://www.ccava.net/'

if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(os.path.abspath(sys.executable))
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

CONFIG_FILE = os.path.join(BASE_DIR, 'config.json')
LOG_FILE = os.path.join(BASE_DIR, 'server.log')
LOG_MAX = 1024 * 1024

DEFAULT_CONFIG = {
    'port': PORT,
}

_voice_cache = {'ts': 0.0, 'data': None}
_cache_lock = threading.Lock()

# 前端会预取后面几段，同一时刻可能有几个合成在跑。开太多会被微软限流，
# 开太少预取就失去意义，4 个并发足够喂满播放又不会踩线。
_synth_slots = threading.BoundedSemaphore(4)

START_TS = time.time()


def log(msg):
    line = '[%s] %s' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg)
    if sys.stdout is not None:
        try:
            print(line, flush=True)
        except Exception:
            pass
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > LOG_MAX:
            if os.path.exists(LOG_FILE + '.old'):
                os.remove(LOG_FILE + '.old')
            os.rename(LOG_FILE, LOG_FILE + '.old')
    except Exception:
        pass
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                user = json.load(f)
            for k, v in user.items():
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    cfg[k].update(v)
                else:
                    cfg[k] = v
        except Exception as exc:
            log('config load failed: %s' % exc)
    return cfg


CONFIG = load_config()
PORT = int(CONFIG.get('port') or 5210)


# ---------------------------------------------------------------- edge 引擎

async def _edge_synth(text, voice, rate, pitch, volume):
    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    buf = bytearray()
    async for chunk in comm.stream():
        if chunk.get('type') == 'audio':
            buf.extend(chunk['data'])
    return bytes(buf)


async def _edge_voices():
    voices = await edge_tts.list_voices()
    out = []
    for v in voices:
        locale = v.get('Locale') or ''
        if not locale.startswith('zh'):
            continue
        out.append({
            'name': v.get('ShortName'),
            'engine': 'edge',
            'locale': locale,
            'gender': v.get('Gender'),
            'friendly': v.get('FriendlyName') or '',
        })
    out.sort(key=lambda x: (x['locale'], x['name']))
    return out


def edge_voices():
    now = time.time()
    if _voice_cache['data'] is not None and now - _voice_cache['ts'] < VOICE_CACHE_TTL:
        return _voice_cache['data']
    # 启动预热线程可能正持着锁。这里必须等，不能立刻返回 None——
    # 否则页面刚打开时 /voices 会返回空列表，前端以为没有在线音色。
    if not _cache_lock.acquire(timeout=25):
        return _voice_cache['data']
    try:
        # 等锁期间别的线程可能已经拉好了，直接用，别重复请求微软
        if (_voice_cache['data'] is not None
                and time.time() - _voice_cache['ts'] < VOICE_CACHE_TTL):
            return _voice_cache['data']
        data = asyncio.run(asyncio.wait_for(_edge_voices(), timeout=20))
        _voice_cache['data'] = data
        _voice_cache['ts'] = time.time()
        log('edge voices: %d' % len(data))
        return data
    except Exception as exc:
        log('edge voices failed: %s' % exc)
        return _voice_cache['data']
    finally:
        _cache_lock.release()


# ---------------------------------------------------------------- HTTP

STATUS_PAGE = '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>在线音色服务运行中 · 本页可关闭</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#f5f6f8;color:#1f2329;
font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:24px}
.card{background:#fff;border-radius:14px;padding:32px 36px;max-width:560px;width:100%;
box-shadow:0 6px 28px rgba(0,0,0,.08)}
h1{margin:0 0 6px;font-size:20px;display:flex;align-items:center;gap:10px}
.dot{width:10px;height:10px;border-radius:50%;background:#22c55e;flex:none;
box-shadow:0 0 0 4px rgba(34,197,94,.16)}
.sub{color:#8a9099;font-size:13px;margin-bottom:16px}
.closehint{margin:0 0 20px;padding:13px 15px;background:#ecfdf5;border:1px solid #a7f3d0;
border-radius:9px;color:#047857;font-size:14px;font-weight:600;line-height:1.65}
.closehint b{color:#065f46}
.row{display:flex;justify-content:space-between;padding:10px 0;border-top:1px solid #eef0f3;font-size:14px}
.row span:first-child{color:#8a9099}
.row span:last-child{font-weight:600;font-variant-numeric:tabular-nums}
.tip{margin-top:20px;padding:12px 14px;background:#f0f7ff;border-radius:9px;
color:#1a5fb4;font-size:13px;line-height:1.65}
.foot{margin-top:18px;padding-top:14px;border-top:1px solid #eef0f3;
text-align:center;font-size:12px;color:#a8aeb8}
.foot a{color:#3a86ff;text-decoration:none}
b{color:#1f2329}
</style></head><body>
<div class="card">
  <h1><i class="dot"></i>在线音色服务运行中</h1>
  <div class="sub">服务已在后台常驻，跟这个页面没有绑定关系。</div>
  <div class="closehint">这个页面<b>可以随时关掉</b>。关掉不影响服务，网页朗读照常能用。</div>
  <div class="row"><span>监听地址</span><span>127.0.0.1:@PORT@</span></div>
  <div class="row"><span>在线音色</span><span>@EDGE@ 个</span></div>
  <div class="row"><span>运行时长</span><span>@UPTIME@</span></div>
  <div class="tip">打开 <b>ccava.net</b> 的工具页，语音下拉里带「（在线）」的就是这些音色。<br>
  停止服务：运行安装目录里的「停止服务.bat」。</div>
  <div class="foot">漫步白月光 &nbsp;·&nbsp; <a href="@HOME@" target="_blank">@HOME@</a></div>
</div></body></html>'''


class TTPServer(ThreadingHTTPServer):
    # Windows 上 SO_REUSEADDR 允许两个进程绑同一端口，会让单实例保护失效
    allow_reuse_address = False
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'LocalTTS/3.0'

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Max-Age', '86400')
        # 公网页面访问 127.0.0.1 要先过浏览器的预检，不显式放行会被拦成 Failed to fetch
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, text):
        body = text.encode('utf-8')
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _audio(self, data, ctype='audio/mpeg'):
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)
        path = parsed.path

        try:
            if path == '/ping':
                self._json({'ok': True, 'port': PORT, 'engine': 'edge',
                            'time': time.time()})
                return

            if path == '/voices':
                edge = edge_voices() or []
                self._json({'ok': True, 'voices': list(edge),
                            'engines': {'edge': len(edge)}})
                return

            if path == '/tts':
                text = (q.get('text', [''])[0] or '').strip()
                if not text:
                    self._json({'ok': False, 'error': 'empty text'}, 400)
                    return
                if len(text) > MAX_TEXT:
                    self._json({'ok': False, 'error': 'text too long, max %d' % MAX_TEXT}, 400)
                    return

                voice = q.get('voice', ['zh-CN-XiaoxiaoNeural'])[0]
                rate = q.get('rate', ['+0%'])[0]
                pitch = q.get('pitch', ['+0Hz'])[0]
                volume = q.get('volume', ['+0%'])[0]

                t0 = time.time()
                data = self._synthesize(text, voice, rate, pitch, volume)
                log('tts %s len=%d %d bytes %.1fs' % (
                    voice, len(text), len(data), time.time() - t0))
                self._audio(data)
                return

            if path in ('/', '/index.html'):
                up = int(time.time() - START_TS)
                h, rem = divmod(up, 3600)
                m, s = divmod(rem, 60)
                uptime = ('%d 小时 ' % h if h else '') + '%d 分 %d 秒' % (m, s)
                edge_n = len(edge_voices() or [])
                page = (STATUS_PAGE
                        .replace('@PORT@', str(PORT))
                        .replace('@EDGE@', str(edge_n) if edge_n else '加载中')
                        .replace('@UPTIME@', uptime)
                        .replace('@HOME@', HOME))
                self._html(page)
                return

            self._json({'ok': False, 'error': 'not found'}, 404)

        except asyncio.TimeoutError:
            log('tts timeout')
            try:
                self._json({'ok': False, 'error': '合成超时，请重试'}, 504)
            except Exception:
                pass
        except Exception as exc:
            log('ERROR %s -> %s' % (path, exc))
            try:
                self._json({'ok': False, 'error': str(exc)}, 500)
            except Exception:
                pass

    def _synthesize(self, text, voice, rate, pitch, volume):
        # 超出并发上限就排队等，别让一堆线程同时怼 edge-tts 被限流
        with _synth_slots:
            data = asyncio.run(asyncio.wait_for(
                _edge_synth(text, voice, rate, pitch, volume), timeout=SYNTH_TIMEOUT))
        if not data:
            raise RuntimeError('empty audio')
        return data


# ---------------------------------------------------------------- 自启

def launch_cmd():
    if getattr(sys, 'frozen', False):
        return '"%s" --autostart' % os.path.abspath(sys.executable)
    return '"%s" "%s" --autostart' % (
        os.path.abspath(sys.executable), os.path.abspath(__file__))


def install_autostart():
    import winreg
    cmd = launch_cmd()
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, APP_NAME, 0, winreg.REG_SZ, cmd)
    log('autostart installed')
    return cmd


def remove_autostart():
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, APP_NAME)
    except FileNotFoundError:
        pass
    log('autostart removed')


def autostart_enabled():
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.QueryValueEx(k, APP_NAME)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------- 桌面快捷方式

SHORTCUT_NAME = '在线音色服务.lnk'


def desktop_dir():
    """优先问 Windows 要桌面路径（OneDrive 重定向 / 中文系统都准）"""
    try:
        import ctypes
        CSIDL_DESKTOPDIRECTORY = 0x10
        buf = ctypes.create_unicode_buffer(1024)
        ctypes.windll.shell32.SHGetFolderPathW(
            None, CSIDL_DESKTOPDIRECTORY, None, 0, buf)
        if buf.value:
            return buf.value
    except Exception:
        pass
    return os.path.join(os.path.expanduser('~'), 'Desktop')


def install_shortcut():
    if not getattr(sys, 'frozen', False):
        log('shortcut skipped: only available in packaged exe')
        return None
    try:
        import pylnk3
    except ImportError as exc:
        log('shortcut skipped: pylnk3 missing (%s)' % exc)
        return None

    exe = os.path.abspath(sys.executable)
    lnk = os.path.join(desktop_dir(), SHORTCUT_NAME)
    try:
        pylnk3.for_file(
            target_file=exe,
            lnk_name=lnk,
            description='在线音色服务 · 漫步白月光 %s' % HOME,
            icon_file=exe,
            icon_index=0,
            work_dir=BASE_DIR,
        )
    except Exception as exc:
        log('shortcut failed: %s' % exc)
        return None

    log('shortcut installed: %s' % lnk)
    return lnk


def remove_shortcut():
    lnk = os.path.join(desktop_dir(), SHORTCUT_NAME)
    try:
        if os.path.exists(lnk):
            os.remove(lnk)
            log('shortcut removed')
    except Exception as exc:
        log('shortcut remove failed: %s' % exc)


# ---------------------------------------------------------------- 启动

def port_busy():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.8)
    try:
        s.connect((HOST, PORT))
        return True
    except OSError:
        return False
    finally:
        s.close()


def probe_ours():
    try:
        with urllib.request.urlopen('http://%s:%d/ping' % (HOST, PORT), timeout=2) as r:
            data = json.loads(r.read().decode('utf-8'))
            return data.get('ok') is True and data.get('port') == PORT
    except Exception:
        return False


def msgbox(text, title='在线音色服务'):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x40)
    except Exception:
        pass


def bind_server():
    last = None
    for _ in range(5):
        try:
            return TTPServer((HOST, PORT), Handler)
        except OSError as exc:
            last = exc
            time.sleep(1)
    log('bind failed: %s' % last)
    return None


def open_status():
    import webbrowser
    try:
        webbrowser.open('http://%s:%d/' % (HOST, PORT))
    except Exception:
        pass


def warmup():
    try:
        edge_voices()
    except Exception:
        pass


def main():
    args = sys.argv[1:]

    if '--install-autostart' in args:
        cmd = install_autostart()
        if sys.stdout is not None:
            print(cmd)
        return 0
    if '--remove-autostart' in args:
        remove_autostart()
        return 0
    if '--check-autostart' in args:
        return 0 if autostart_enabled() else 1
    if '--install-shortcut' in args:
        return 0 if install_shortcut() else 1
    if '--remove-shortcut' in args:
        remove_shortcut()
        return 0
    if '--status' in args:
        return 0 if port_busy() else 1

    silent = '--autostart' in args

    if port_busy():
        if probe_ours():
            log('already running')
            if not silent:
                open_status()
            return 0
        log('port %d occupied by another program' % PORT)
        if not silent:
            msgbox('端口 %d 被其他程序占用了，服务无法启动。\n\n'
                   '可以先关掉占用该端口的程序再试，或者重启电脑。' % PORT)
        return 1

    srv = bind_server()
    if srv is None:
        if not silent:
            open_status()
        return 1

    log('listening on http://%s:%d (pid %d)' % (HOST, PORT, os.getpid()))

    threading.Thread(target=warmup, daemon=True).start()

    if not silent:
        threading.Timer(1.2, open_status).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log('stopped by user')
    finally:
        srv.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
