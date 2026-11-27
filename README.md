# CCAVA LocalTTS · 在线音色本地服务

> 让 Windows 浏览器的朗读功能从「1~4 个音色」变成「14 个中文在线神经音色」
>
> 作者：漫步白月光 · 官网 [https://www.ccava.net/](https://www.ccava.net/)

**配合使用**：[本地小说阅读器 · https://www.ccava.net/toolbox/novel-reader.html](https://www.ccava.net/toolbox/novel-reader.html)

[![Release](https://img.shields.io/github/v/release/361611074/ccava-local-tts?label=release)](../../releases)
[![License](https://img.shields.io/github/license/361611074/ccava-local-tts)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.9%2B-blue)](https://www.python.org/)

---

## 这个项目解决什么问题

浏览器的朗读功能靠 `speechSynthesis` 接口，而它只能读系统里注册的 **SAPI5** 音色。

Windows 中文系统通常只注册 3 个：

```
Microsoft Huihui  - Chinese (Simplified, PRC)
Microsoft Kangkang - Chinese (Simplified, PRC)
Microsoft Yaoyao  - Chinese (Simplified, PRC)
```

听起来机械、单调，也没有方言和风格可选。

而真正好听的音色——晓晓、云希、晓北（东北话）、晓妮（陕西话）、粤语曉佳、台湾曉臻——
都是**在线神经语音**，浏览器原生接口拿不到。

网上常见的建议是「去装语音包」，但中文语音包在 Windows 上非常有限，
而且 SAPI5 和 OneCore 是两套注册表，装了也未必被浏览器识别。

## 这个项目怎么解决

在你自己电脑上起一个只监听 `127.0.0.1` 的小服务，把微软 Edge 的在线语音合成
包装成 HTTP 接口；再用一段适配层接管页面的 `speechSynthesis`，
把 14 个在线音色混进 `getVoices()` 的返回结果里。

```
┌─────────────────────────────────────────────┐
│  网页（ccava.net/toolbox/novel-reader.html）  │
│                                             │
│  speechSynthesis.getVoices()                │
│    ├── 3 个系统音色（原生，走浏览器）           │
│    └── 14 个在线音色（虚拟，走本地服务）         │
└──────────────────┬──────────────────────────┘
                   │ http://127.0.0.1:5210/tts
                   ▼
┌─────────────────────────────────────────────┐
│  TTS-Server.exe（本机，只监听 127.0.0.1）      │
│    edge-tts → 微软 Edge 朗读通道 → mp3        │
└─────────────────────────────────────────────┘
```

**网页代码一行都不用改。** 选中的音色如果是虚拟音色，就改走本地服务合成的 mp3；
如果是系统音色，照旧走浏览器原生朗读。

## 音色列表

| 音色 | 性别 | 说明 | locale |
|---|---|---|---|
| 晓晓 | 女 | 标准，最通用 | zh-CN |
| 晓伊 | 女 | 温柔 | zh-CN |
| 云健 | 男 | 浑厚 | zh-CN |
| 云希 | 男 | 阳光 | zh-CN |
| 云夏 | 男 | 少年 | zh-CN |
| 云扬 | 男 | 播音腔 | zh-CN |
| 晓北 | 女 | **东北话** | zh-CN-liaoning |
| 晓妮 | 女 | **陕西话** | zh-CN-shaanxi |
| 曉佳 | 女 | **粤语** | zh-HK |
| 曉曼 | 女 | **粤语** | zh-HK |
| 雲龍 | 男 | **粤语** | zh-HK |
| 曉臻 | 女 | 台湾腔 | zh-TW |
| 曉雨 | 女 | 台湾腔 | zh-TW |
| 雲哲 | 男 | 台湾腔 | zh-TW |

全部免费、免密钥、无需注册。实际数量以 `/voices` 接口返回为准（微软可能调整列表）。

## 快速开始

### 方式一：下载安装包（推荐）

1. 到 [Releases](../../releases/latest) 下载 `CCAVA-LocalTTS-v*.zip`（约 10 MB）
2. **整个解压**（不要只拖出某个文件）
3. 双击 `一键安装.bat`
4. 中途会问要不要开机自启，按 `Y` 或 `N`
5. 装完桌面上会出现「在线音色服务」图标

然后打开 [https://www.ccava.net/toolbox/novel-reader.html](https://www.ccava.net/toolbox/novel-reader.html)，
语音下拉里带「（在线）」的就是新增音色。

> 如果弹出「Windows 已保护你的电脑」：点「更多信息」→「仍要运行」。
> 这是因为程序没有购买代码签名证书，属正常提示。

### 方式二：源码运行

需要 Python 3.9+。

```bash
git clone https://github.com/361611074/ccava-local-tts.git
cd ccava-local-tts

pip install edge-tts
python tts_server.py
```

会自动打开状态页。看到蓝色卡片「在线音色服务运行中」就成功了。

手动验证：

```bash
curl http://127.0.0.1:5210/ping
curl http://127.0.0.1:5210/voices
```

直接听一耳朵：

```bash
curl -o test.mp3 "http://127.0.0.1:5210/tts?text=你好，这是测试&voice=zh-CN-XiaoxiaoNeural"
```

## 日常管理

装完之后，所有操作都在安装目录 `%LOCALAPPDATA%\CCAVA-TTS\` 里：

| 想做的事 | 怎么做 |
|---|---|
| 启动服务 | 双击桌面「在线音色服务」 |
| 停止服务 | `停止服务.bat` |
| 开启开机自启 | `开启开机自启.bat` |
| 关闭开机自启 | `关闭开机自启.bat` |
| 完全卸载 | `卸载.bat`（连桌面图标和自启项一起清） |
| 确认在跑 | 浏览器打开 `http://127.0.0.1:5210/` |

### 状态页可以关吗

**可以，随便关。** 状态页只是服务对 `GET /` 的一个响应，关标签页、关整个浏览器都不影响后台进程。

实测：打开状态页 → 关掉标签 → 关掉整个浏览器 → `/ping` 仍然 200，`/tts` 仍能正常合成。

### 为什么任务管理器里有 2 个进程

PyInstaller 单文件打包的程序跑起来就是「引导器 + 真身」两个进程，正常现象。

## 接口

服务就四个端点，全是 GET，全部允许跨域（含 `Access-Control-Allow-Private-Network`）。

| 路径 | 说明 |
|---|---|
| `/ping` | 健康检查 `{"ok":true,"port":5210,"engine":"edge"}` |
| `/voices` | 音色列表 |
| `/tts?text=&voice=&rate=&pitch=&volume=` | 合成，直接返回 mp3 字节流 |
| `/` | 状态页 |

参数格式和 edge-tts 一致，`rate` 用 `+0%`、`pitch` 用 `+0Hz`、`volume` 用 `+0%`。

单次请求文本上限 1200 字。前端适配层为播放连贯性按 280 字切段，并提前预取后面几段（见下方「坑四」）。

服务端对同时进行的合成有 4 路并发上限。预取会同时发几个请求，不设上限容易被微软限流；
设太小又会让预取失去意义，4 路是实测下来既能喂满播放、又不踩线的值。

## 命令行参数

| 参数 | 作用 |
|---|---|
| 无参数 | 启动服务并打开状态页 |
| `--autostart` | 静默启动（开机自启用的就是这个） |
| `--status` | 服务在跑返回 0，否则返回 1 |
| `--install-autostart` | 写入 `HKCU\...\Run` |
| `--remove-autostart` | 删除自启项 |
| `--check-autostart` | 已设自启返回 0 |
| `--install-shortcut` | 桌面建快捷方式（仅打包后的 exe 有效） |
| `--remove-shortcut` | 删除桌面快捷方式 |

## 前端适配层

`web/tts-bridge.js` 是配合网页用的接管脚本，核心是重写 `speechSynthesis` 的三个方法：
`getVoices()`、`speak()`、`cancel()`。

接进任何网页只要两步：

1. 引入 `web/tts-bridge.js`
2. 服务在跑

有三个坑必须处理，否则跑不通：

### 坑一：`SpeechSynthesisUtterance.voice` 的类型检查

原生 setter 只接受真正的 `SpeechSynthesisVoice`，普通对象和 `Proxy` 都会被拒：

```
Failed to convert value to 'SpeechSynthesisVoice'
```

解法是直接接管这个属性：

```js
var desc = Object.getOwnPropertyDescriptor(SpeechSynthesisUtterance.prototype, 'voice');
Object.defineProperty(SpeechSynthesisUtterance.prototype, 'voice', {
  configurable: true,
  get: function () { return this.__ttsVoice || (desc.get && desc.get.call(this)); },
  set: function (v) {
    if (v && v.__edge) { this.__ttsVoice = v; return; }
    this.__ttsVoice = null;
    if (desc.set) desc.set.call(this, v);
  }
});
```

### 坑二：`speechSynthesis.speaking` 无限递归

这个坑很隐蔽。如果你这样写：

```js
Object.defineProperty(synth, 'speaking', {
  get: function () { return !!state.utter || synth.speaking === true; }  // 自己调自己
});
```

`synth.speaking` 已经被替换成这个 getter，于是无限递归，抛
`RangeError: Maximum call stack size exceeded`。页面里**任何一处**读
`speechSynthesis.speaking` 都会炸——而朗读类页面几乎必然要读它。

正确做法是先把原生取值器抓下来：

```js
var nativeSpeaking = (function () {
  var d = Object.getOwnPropertyDescriptor(synth, 'speaking')
       || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(synth), 'speaking');
  return d && d.get ? function () { return d.get.call(synth); } : function () { return false; };
})();
```

### 坑三：本地网络访问限制

Chrome 138+ 起，公网页面请求 `127.0.0.1` 要走 Private Network Access 预检。
服务端必须回这几个头，否则请求在浏览器侧就被拦掉，服务端连日志都看不到：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Private-Network: true
```

OPTIONS 预检也要正常回 204。`tts_server.py` 里已经处理好了。

### 坑四：朗读卡顿（三层原因，一层比一层隐蔽）

这个坑踩了三次，每次以为修好了，实际只解决了一层。记录下来省得下次再绕。

#### 第一层：串行合成

按「上一段播完 → 才去请求下一段 → 等合成 → 再播」的顺序做，每次切段都要空等
一次完整合成（实测 1.3~1.7 秒）。280 字约一分钟音频，所以每分钟卡一次。

修法：**预取**——当前段在播的时候，后面几段已经在合成。

#### 第二层：首段太长 + 预取抢资源

合成耗时由**固定开销主导，不是线性的**：80 字约 1.6 秒，260 字约 2.9 秒。
一上来就切 280 字，用户点下朗读要干等 5 秒才出声。

而预取如果立刻发，会和当前段的合成抢线程——实测每段都从 1.6 秒拖到 2.8 秒，
首段反而更慢。

修法：首段切到 80 字；预取延迟 800ms 再发（够当前段把请求送出去，
而下一段离播放还有几十秒）。

#### 第三层：每段音频自带 700 毫秒静音（最隐蔽）

前两层修完，播放器的段间空档已经压到 **6 毫秒**，数据非常漂亮，
但耳朵还是觉得「一段一段、不连贯」。原因是量错了地方：

```
播放器切换间隔   6 ms      ← 之前一直在量这个
音频内部的静音  737 ms     ← 真正的问题在这里
```

实测（多段一致，非常稳定）：

| 位置 | 静音长度 |
|---|---|
| 段首 | 188 ms |
| 段尾 | 538 ms |
| 首尾相接 | **726 ms** |

七段就是 4.4 秒空白，每个接缝约 0.7 秒——听起来正好是「一句一停，像分段播报」。

修法两件事：

1. **裁静音**。解码成 PCM 后扫描振幅，段首留 20ms、段尾留 160ms，
   句末该有的自然停顿还在，多余的死气去掉。接缝从 726ms 降到 180ms。
2. **换 Web Audio 精确排期**。不再用 `<audio>` 元素逐段切换，改成
   `AudioBufferSourceNode.start(when)`，`when` 按上一段的结束时间累加。
   这样段与段是采样级首尾相接，没有元素切换的缝。

```
段1  start(1.84)  ── 13.272s ──►  结束 15.113
段2  start(15.113) ── 54.545s ──►  结束 69.658     ← 间隔 0.000s
段3  start(69.658) ── 54.545s ──►  结束 124.203
```

#### 三轮修法的实测对比（1560 字，7 段）

| 指标 | 串行 | +预取 | +首段短 | +裁静音&Web Audio |
|---|---|---|---|---|
| 首段出声 | 4994 ms | 4994 ms | **1649 ms** | **1649 ms** |
| 播放器段间空档 | ~2000 ms | ~2000 ms | 6 ms | **0 ms** |
| 实际听到的接缝静音 | ~2000 ms | ~2000 ms | ~740 ms | **180 ms** |
| 7 段累计 | ~12 s | ~12 s | ~4.4 s | **~1.1 s** |

#### 实现要点

- 预解码**单请求串行**，同一时刻只有一个合成在跑。并发会互相抢资源，
  而串行完全跟得上播放（合成 3 秒 vs 播放 70 秒）。
- 提前备 2 段就够。别开大——解码后的 PCM 按 48kHz float32 算约 **11.5MB/分钟**，
  留 3 段就是 40MB，长章节能吃掉几百兆。
- **播完立刻 `delete` 那段 PCM**，不然内存只增不减。
- 排期游标如果落到过去（首段，或中间被卡了一下），重新对齐到 `currentTime + 60ms`，
  否则 `start()` 传一个过期时间点会直接开始播，接缝反而更乱。
- 没有 `AudioContext` 的浏览器退回逐段 `<audio>`，接缝会比较明显但至少能听。
- `AudioContext` 如果在用户手势之外创建会被挂起（表现为点了朗读没声音）。
  页面自动续读下一章时可能踩到，所以在 `pointerdown`/`keydown` 上补一次 `resume()`。

### 坑五：音色列表的锁把网络请求关在里面

`/voices` 需要向微软拉一次音色列表并缓存。如果缓存锁把整个 `await` 包在里面，
那么开机自启时预热线程一开跑，所有 `/voices` 请求都得排队等它——最坏等 25 秒。
用户看到的现象是页面像卡死，而不是「稍等」。

正确做法是**锁只保护状态**：谁抢到「正在拉取」的标志谁去拉，其余请求最多等几秒，
等不到就先返回旧缓存，让前端自己重试。网络请求永远不在锁里。


## 自己打包

```bash
pip install pyinstaller edge-tts pylnk3
python build/build.py
```

产物：

```
dist/TTS-Server.exe        单文件可执行程序
CCAVA在线音色.zip           分发压缩包（exe + 5 个 bat + 3 份文档）
```

几个要点：

- **必须 `--collect-data certifi`**，否则 SSL 证书找不到，所有请求失败
- `--noconsole` 后 `sys.stdout` 是 `None`，代码里所有 `print` 都要判空
- bat 必须 **GBK + CRLF**。UTF-8 的 bat 配 `chcp 65001` 会让 cmd 算错行字节数，中文被截断当命令执行
- 桌面快捷方式用 `pylnk3` 纯 Python 写，不依赖 COM

## 项目结构

```
ccava-local-tts/
├── tts_server.py          服务端源码（单文件，约 500 行）
├── config.example.json    配置模板
├── web/
│   └── tts-bridge.js      前端适配层
├── build/
│   ├── build.py           一键打包脚本
│   ├── release.py         创建 Release 并上传附件（token 走环境变量）
│   ├── TTS-Server.spec    PyInstaller 配置
│   ├── version_info.txt   exe 版本信息
│   └── tts.ico            图标
├── docs/
│   ├── 使用说明.txt        给普通用户看的
│   ├── 搭建指南.md         从零复刻的完整步骤
│   └── 服务端说明.md       接口与架构
└── README.md
```

## 常见问题

**Q：`pip install edge-tts` 报找不到版本**
A：Python 版本太老（3.8 及以下）。升到 3.9+。

**Q：状态页能打开，但网页里音色没变**
A：先刷新网页（Ctrl+F5）。还不行就看浏览器控制台有没有 `Failed to fetch`——
那多半是本地网络权限被拦，见「坑三」。

**Q：朗读报 500**
A：看 `%LOCALAPPDATA%\CCAVA-TTS\server.log`。最常见是网络不通，或者 edge-tts
版本太旧被微软改了协议——`pip install -U edge-tts` 通常就好了。

**Q：端口 5210 被占用**
A：改 `config.json` 里的 `port`，同时把 `web/tts-bridge.js` 开头的 `var API` 一起改掉。

**Q：会消耗很多流量吗**
A：不经过任何服务器，本机直连微软，不花一分钱。每段朗读大概几十 KB。

**Q：能装在服务器上给别人用吗**
A：技术上可以，但所有请求会从同一个 IP 出去，容易被微软限流；还要考虑带宽和缓存。
这个项目定位是**本地服务**，不建议做成公网接口。

**Q：会被杀毒软件拦吗**
A：打包成 exe 的 Python 程序偶尔会被误报。加入信任即可。源码逻辑很简单：
接收文字 → 调在线接口 → 返回 mp3，没有别的动作。

## 说明

- 只监听 `127.0.0.1`，不接收外部连接
- 不收集任何数据，日志只有合成记录（音色、字数、耗时）
- 走的是 Edge 浏览器的朗读接口，**非官方 API**，微软哪天改了协议可能就失效，
  届时升级 `edge-tts` 库通常能恢复
- 不需要任何密钥，不产生任何费用

## 许可

[MIT](LICENSE) · 代码可自由使用和修改，保留出处即可。

---

漫步白月光 · [https://www.ccava.net/](https://www.ccava.net/)
