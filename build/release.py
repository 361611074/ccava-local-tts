# -*- coding: utf-8 -*-
"""创建 GitHub Release 并上传分发包

用法：
    set GITHUB_TOKEN=ghp_xxx        （Windows cmd）
    export GITHUB_TOKEN=ghp_xxx     （bash）
    python build/release.py

token 只从环境变量读，不写进文件。需要 repo 权限（fine-grained 需要 Contents 读写）。
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TOK = os.environ.get('GITHUB_TOKEN', '').strip()
if not TOK:
    sys.exit('请先设置环境变量 GITHUB_TOKEN')

OWNER = os.environ.get('GITHUB_OWNER', '361611074')
REPO = os.environ.get('GITHUB_REPO', 'ccava-local-tts')
TAG = os.environ.get('GITHUB_TAG', 'v3.1.2')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP = os.path.join(ROOT, 'CCAVA在线音色.zip')
# GitHub 会把非 ASCII 字符从附件名里剔掉（「CCAVA在线音色.zip」会变成「CCAVA.zip」），
# 所以上传时统一用 ASCII 名。压缩包内部的中文目录名不受影响。
ASSET_NAME = 'CCAVA-LocalTTS-%s.zip' % TAG

H = {
    'Authorization': 'Bearer ' + TOK,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'ccava-deploy',
    'X-GitHub-Api-Version': '2022-11-28',
}

BODY = """## 本次更新 · v3.1.2

**把卡顿彻底压平了，并修掉了首次打开页面可能白等 30 秒的问题。**

### 卡顿：段间空档 2000 毫秒 → 6 毫秒

v3.1.1 已经改成预取，但还留了两处摩擦：

- **首段太长**。合成耗时由固定开销主导——80 字约 1.6 秒，260 字约 2.9 秒。
  以前一上来就切 280 字，点下朗读要干等 5 秒才出声。现在首段只切 80 字，后续才是 280 字。
- **预取抢资源**。播完一段立刻去预取下一段，会和当前段的合成抢线程，
  每段反而从 1.6 秒拖到 2.8 秒，首段出声更慢。现在延迟 800 毫秒再发——
  当前段早把请求送出去了，而下一段离播放还有几十秒，完全来得及。

实测（1560 字，7 段）：

| 指标 | v3.1.1 | v3.1.2 |
|---|---|---|
| 首段出声 | 4994 ms | **1649 ms** |
| 段间空档 | ~2000 ms | **6 ms** |
| 7 段累计停顿 | ~12 秒 | **36 ms** |

### 首次打开页面不再干等

音色列表的缓存锁以前把整个网络请求关在锁里。开机自启时预热线程一开跑，
所有 `/voices` 请求都得排队等它，最坏等 25 秒——表现就是页面像卡死了。

现在锁只保护状态：谁抢到「正在拉取」的标志谁去拉，其余请求最多等 6 秒，
拿不到就先返回旧数据，前端会自己重试。网络请求永远不在锁里。

### 另外

- 服务端保留 4 路合成并发上限，预取不会把微软那边打限流
- 音色加载重试窗口约 4 分钟，服务预热慢也能等到，不用手动刷新

**升级方式**：直接覆盖安装即可，配置和自启项都不用重设。

---

## 让 Windows 浏览器朗读拥有 14 个中文在线音色

Windows 中文系统只注册 3 个朗读音色（慧慧、康康、瑶瑶），听起来机械单调，
也没有方言和风格可选。

这个服务在你本机起一个只监听 `127.0.0.1` 的接口，把微软 Edge 的 14 个在线神经音色
接进浏览器，包括东北话、陕西话、粤语、台湾腔。

**配合使用**：[本地小说阅读器 · ccava.net/toolbox/novel-reader.html](https://www.ccava.net/toolbox/novel-reader.html)

---

## 下载

`CCAVA在线音色.zip`（9.9 MB）

## 安装

1. 把压缩包**整个解压**（不要只拖出某个文件）
2. 双击 `一键安装.bat`
3. 中途会问要不要开机自启，按 `Y` 或 `N`
4. 装完桌面上会出现「在线音色服务」图标

打开[工具页](https://www.ccava.net/toolbox/novel-reader.html)，
语音下拉里带「（在线）」的就是新增音色。

> 首次运行如果提示「Windows 已保护你的电脑」：点「更多信息」→「仍要运行」。
> 这是因为程序没有购买代码签名证书，属正常提示，不是病毒。

## 音色列表

| 音色 | 说明 |
|---|---|
| 晓晓 / 晓伊 | 女声，标准 / 温柔 |
| 云健 / 云希 / 云夏 / 云扬 | 男声，浑厚 / 阳光 / 少年 / 播音 |
| 晓北 | 女声，**东北话** |
| 晓妮 | 女声，**陕西话** |
| 曉佳 / 曉曼 / 雲龍 | **粤语** |
| 曉臻 / 曉雨 / 雲哲 | 台湾腔 |

全部免费、免密钥、无需注册、不产生任何费用。

## 说明

- 只监听 `127.0.0.1`，不接收外部连接
- 不收集任何数据，日志只有合成记录（音色、字数、耗时）
- 走 Edge 浏览器的朗读接口，**非官方 API**，微软改协议时升级 `edge-tts` 即可恢复
- 状态页可以随时关掉，不影响后台服务

## 从源码运行

```bash
git clone https://github.com/361611074/ccava-local-tts.git
cd ccava-local-tts
pip install edge-tts
python tts_server.py
```

---

漫步白月光 · [https://www.ccava.net/](https://www.ccava.net/)
"""


def api(path, method='GET', body=None, base='https://api.github.com'):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers=H, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, e.read().decode('utf-8', 'replace')[:500]


def main():
    if not os.path.exists(ZIP):
        print('找不到压缩包:', ZIP)
        return 1
    print('压缩包:', ZIP, '%.1f MB' % (os.path.getsize(ZIP) / 1024 / 1024))

    print('\n[1] 创建 Release')
    st, d = api('/repos/%s/%s/releases' % (OWNER, REPO), 'POST', {
        'tag_name': TAG,
        'name': 'CCAVA 在线音色服务 %s' % TAG,
        'body': BODY,
        'draft': False,
        'prerelease': False,
    })
    if st == 422:
        print('    已存在，改用查询')
        st, d = api('/repos/%s/%s/releases/tags/%s' % (OWNER, REPO, TAG))
    if st not in (200, 201):
        print('    失败 HTTP', st, d)
        return 1
    rid = d['id']
    print('    Release id:', rid)
    print('    页面:', d['html_url'])

    print('\n[2] 上传附件')
    for a in d.get('assets', []):
        if a['name'] == ASSET_NAME:
            print('    已存在同名附件，先删除 id=%s' % a['id'])
            api('/repos/%s/%s/releases/assets/%s' % (OWNER, REPO, a['id']), 'DELETE')

    with open(ZIP, 'rb') as f:
        payload = f.read()

    url = ('https://uploads.github.com/repos/%s/%s/releases/%s/assets?name=%s'
           % (OWNER, REPO, rid, urllib.parse.quote(ASSET_NAME)))
    req = urllib.request.Request(url, data=payload, headers=dict(H, **{
        'Content-Type': 'application/zip',
        'Content-Length': str(len(payload)),
    }), method='POST')
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            a = json.load(r)
        print('    上传成功')
        print('    附件:', a['name'], '%.1f MB' % (a['size'] / 1024 / 1024))
        print('    直链:', a['browser_download_url'])
    except urllib.error.HTTPError as e:
        print('    上传失败 HTTP', e.code)
        print('   ', e.read().decode('utf-8', 'replace')[:600])
        return 1

    print('\n完成')
    print('  仓库  : https://github.com/%s/%s' % (OWNER, REPO))
    print('  正式版: https://github.com/%s/%s/releases/tag/%s' % (OWNER, REPO, TAG))
    return 0


if __name__ == '__main__':
    sys.exit(main())
