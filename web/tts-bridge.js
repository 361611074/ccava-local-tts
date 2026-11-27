/**
 * 在线音色适配层  ·  漫步白月光  https://www.ccava.net/
 *
 * 浏览器原生的 speechSynthesis 只能读系统 SAPI5 音色，Windows 上中文就 1~4 个。
 * 这段脚本在页面加载后接管 speechSynthesis，把本地 TTS 服务提供的在线音色
 * 混进音色列表，朗读时改用服务合成的音频播放。
 *
 * 不依赖任何框架。原生音色照旧走浏览器，只有虚拟音色走本地服务。
 *
 * v5 解决「一段一段、不连贯」：
 *
 *   实测每段合成音频自带 段首 188ms + 段尾 538ms 静音（非常稳定）。
 *   两段首尾相接，每个接缝就有 726 毫秒没声音——七段就是 4.4 秒空白，
 *   听感正好是「一句一停」。之前 v4 的预取只消掉了「等合成」，
 *   没消掉音频内部的静音，所以数据漂亮、耳朵还是觉得断。
 *
 *   1. 解码成 PCM 后裁静音：段首留 20ms、段尾留 160ms，句末自然停顿还在，
 *      多余的死气去掉，每个接缝从 726ms 降到约 180ms
 *   2. 用 AudioContext 精确排期（BufferSource.start(when)），
 *      不再是「一段播完再播下一段」，而是采样级首尾相接，没有元素切换的缝
 *   3. 单请求串行预解码（不并发抢合成资源），提前 3 段备好
 */
(function () {
    'use strict';

    var API = 'http://127.0.0.1:5210';
    var synth = window.speechSynthesis;

    if (!synth) {
        return;
    }

    if (synth.__ttsBridge) {
        return;
    }

    // 服务端给的是 ShortName，这里补中文名。没列到的走 friendly 字段。
    var CN_NAMES = {
        'zh-CN-XiaoxiaoNeural': '晓晓 · 女 · 标准',
        'zh-CN-XiaoyiNeural': '晓伊 · 女 · 温柔',
        'zh-CN-YunjianNeural': '云健 · 男 · 浑厚',
        'zh-CN-YunxiNeural': '云希 · 男 · 阳光',
        'zh-CN-YunxiaNeural': '云夏 · 男 · 少年',
        'zh-CN-YunyangNeural': '云扬 · 男 · 播音',
        'zh-CN-liaoning-XiaobeiNeural': '晓北 · 女 · 东北话',
        'zh-CN-shaanxi-XiaoniNeural': '晓妮 · 女 · 陕西话',
        'zh-HK-HiuGaaiNeural': '曉佳 · 女 · 粤语',
        'zh-HK-HiuMaanNeural': '曉曼 · 女 · 粤语',
        'zh-HK-WanLungNeural': '雲龍 · 男 · 粤语',
        'zh-TW-HsiaoChenNeural': '曉臻 · 女 · 台湾',
        'zh-TW-HsiaoYuNeural': '曉雨 · 女 · 台湾',
        'zh-TW-YunJheNeural': '雲哲 · 男 · 台湾'
    };

    // 首段短，点下朗读能快速出声；后面段拉长，减少接缝数量。
    // 合成耗时由固定开销主导（80 字约 1.6 秒，260 字约 2.9 秒），
    // 所以首段短是「快出声」的关键，后续长是「少接缝」的关键。
    var FIRST_CHUNK = 80;
    var MAX_CHUNK = 300;

    // 裁静音参数。实测段首 188ms、段尾 538ms，这里保留句末该有的自然停顿，
    // 只砍掉多余的。留太少会削掉辅音起音，听着发硬。
    var TRIM_THRESHOLD = 0.004;   // 约 -48 dBFS，低于这个算静音
    var HEAD_KEEP = 0.02;         // 段首保留 20ms
    var TAIL_KEEP = 0.16;         // 段尾保留 160ms

    // 提前备好几段（解码后的 PCM）。合成一段要 1.6~3 秒，而一段音频能放
    // 60~90 秒，所以 2 段足够覆盖任何抖动。别开太大——解码后的 PCM 按
    // 48kHz float32 算约 11.5MB/分钟，留太多会吃掉几百兆内存。
    var AHEAD = 2;

    // 首段排期留一点余量，避免 start 时时间点已经过期
    var START_LEAD = 0.06;

    // 开机后服务可能还在预热，页面就打开了。失败时多试几次，别一次失败就放弃。
    var RETRY_DELAYS = [0, 1000, 2000, 3000, 5000, 8000, 12000, 15000, 20000];

    var nativeGetVoices = synth.getVoices.bind(synth);
    var nativeSpeak = synth.speak.bind(synth);
    var nativeCancel = synth.cancel.bind(synth);
    var nativePause = synth.pause.bind(synth);
    var nativeResume = synth.resume.bind(synth);

    var virtualVoices = [];

    var state = {
        audio: null,      // 退路模式（没有 Web Audio）用的 <audio>
        queue: [],
        urls: [],
        utter: null,
        cancelled: false,
        paused: false,
        seq: 0
    };

    // 解码后的段：index -> AudioBuffer（已裁静音）或 null（全静音 / 合成失败）
    var decoded = {};
    var prefetching = false;
    var prefetchNext = 0;

    // 播放调度状态
    var play = {
        ctx: null,
        next: 0,        // 下一段要排的索引
        cursor: 0,      // 下一个可排的时间点（AudioContext 时间轴）
        sources: [],
        scheduled: 0,
        played: 0,
        running: false
    };

    function toEdgeRate(rate) {
        var r = typeof rate === 'number' && isFinite(rate) ? rate : 1;
        var pct = Math.round((r - 1) * 100);
        if (pct > 100) pct = 100;
        if (pct < -90) pct = -90;
        return (pct >= 0 ? '+' : '') + pct + '%';
    }

    function toEdgePitch(pitch) {
        var p = typeof pitch === 'number' && isFinite(pitch) ? pitch : 1;
        var hz = Math.round((p - 1) * 50);
        if (hz > 100) hz = 100;
        if (hz < -100) hz = -100;
        return (hz >= 0 ? '+' : '') + hz + 'Hz';
    }

    function toEdgeVolume(volume) {
        var v = typeof volume === 'number' && isFinite(volume) ? volume : 1;
        var pct = Math.round((v - 1) * 100);
        if (pct > 100) pct = 100;
        if (pct < -100) pct = -100;
        return (pct >= 0 ? '+' : '') + pct + '%';
    }

    function labelOf(v) {
        return CN_NAMES[v.name] || v.friendly || v.name;
    }

    // SpeechSynthesisUtterance.voice 的 setter 会做类型检查，普通对象会被拒
    // （Failed to convert value to 'SpeechSynthesisVoice'）。
    // 用 Proxy 包住一个真实语音对象，类型检查能过，读出来的属性是我们想要的。
    function buildVoice(v, sample) {
        var meta = {
            name: labelOf(v) + '（在线）',
            lang: v.locale,
            voiceURI: 'localtts:' + v.name,
            localService: true,
            default: false,
            __edge: v.name
        };

        if (!sample) {
            return meta;
        }

        return new Proxy(sample, {
            get: function (target, prop) {
                if (Object.prototype.hasOwnProperty.call(meta, prop)) {
                    return meta[prop];
                }
                var val = target[prop];
                return typeof val === 'function' ? val.bind(target) : val;
            },
            has: function (target, prop) {
                return Object.prototype.hasOwnProperty.call(meta, prop) || prop in target;
            },
            ownKeys: function () {
                return Object.keys(meta);
            },
            getOwnPropertyDescriptor: function (target, prop) {
                if (Object.prototype.hasOwnProperty.call(meta, prop)) {
                    return { value: meta[prop], enumerable: true, configurable: true, writable: false };
                }
                return Object.getOwnPropertyDescriptor(target, prop);
            }
        });
    }

    function edgeNameOf(voice) {
        if (!voice) return null;
        try {
            var n = voice.__edge;
            if (n) return n;
        } catch (e) {}
        try {
            var uri = voice.voiceURI;
            if (typeof uri === 'string' && uri.indexOf('localtts:') === 0) {
                return uri.slice(9);
            }
        } catch (e) {}
        return null;
    }

    // 原生 setter 只收真正的 SpeechSynthesisVoice，所以直接接管这个属性：
    // 虚拟音色存在自定义字段里，不进原生 setter。
    try {
        var UtterCtor = window.SpeechSynthesisUtterance;
        var voiceDesc = UtterCtor && Object.getOwnPropertyDescriptor(UtterCtor.prototype, 'voice');
        if (voiceDesc && voiceDesc.configurable) {
            Object.defineProperty(UtterCtor.prototype, 'voice', {
                configurable: true,
                enumerable: voiceDesc.enumerable,
                get: function () {
                    if (this.__ttsVoice) return this.__ttsVoice;
                    return voiceDesc.get ? voiceDesc.get.call(this) : null;
                },
                set: function (val) {
                    var edge = edgeNameOf(val);
                    if (edge) {
                        this.__ttsVoice = val;
                        this.__ttsEdge = edge;
                        return;
                    }
                    this.__ttsVoice = null;
                    this.__ttsEdge = null;
                    if (voiceDesc.set) voiceDesc.set.call(this, val);
                }
            });
        }
    } catch (e) {}

    // 原生 speaking / paused 的取值器必须先抓下来。
    // 直接在自己的 getter 里写 synth.speaking 会无限递归（RangeError: Maximum call stack size exceeded），
    // 页面任何一处读 speechSynthesis.speaking 都会炸。
    var nativeSpeaking = (function () {
        var d = Object.getOwnPropertyDescriptor(synth, 'speaking')
            || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(synth), 'speaking');
        return d && d.get ? function () { return d.get.call(synth); } : function () { return false; };
    })();

    var nativePaused = (function () {
        var d = Object.getOwnPropertyDescriptor(synth, 'paused')
            || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(synth), 'paused');
        return d && d.get ? function () { return d.get.call(synth); } : function () { return false; };
    })();

    try {
        Object.defineProperty(synth, 'speaking', {
            configurable: true,
            get: function () {
                if (state.utter) return true;
                try { return nativeSpeaking(); } catch (e) { return false; }
            }
        });
    } catch (e) {}

    try {
        Object.defineProperty(synth, 'paused', {
            configurable: true,
            get: function () {
                if (state.paused) return true;
                try { return nativePaused(); } catch (e) { return false; }
            }
        });
    } catch (e) {}

    // 切分：按句号问号等断句，首段短、后续长
    function splitText(text) {
        var sents = String(text).split(/(?<=[。！？；：…\n])/);
        var out = [];
        var buf = '';

        function limit() {
            return out.length === 0 ? FIRST_CHUNK : MAX_CHUNK;
        }

        for (var i = 0; i < sents.length; i++) {
            var s = sents[i];
            if (!s) continue;

            // 这一句装得下就接着攒
            if (buf.length + s.length <= limit()) {
                buf += s;
                continue;
            }

            // 装不下：先把攒的收尾
            if (buf) {
                out.push(buf);
                buf = '';
            }

            // 单句自己就超长，按逗号硬切
            while (s.length > limit()) {
                var lim = limit();
                var cut = s.lastIndexOf('，', lim);
                if (cut < lim * 0.4) cut = lim;
                out.push(s.slice(0, cut));
                s = s.slice(cut);
            }
            buf = s;
        }

        if (buf) out.push(buf);
        return out.length ? out : [String(text)];
    }

    function fire(utter, name) {
        if (utter && typeof utter[name] === 'function') {
            try {
                utter[name]({ type: name.replace('on', ''), charIndex: 0, elapsedTime: 0 });
            } catch (e) {}
        }
    }

    function buildUrl(text, utter) {
        var voiceName = (utter && utter.__ttsEdge) || edgeNameOf(utter && utter.voice) || 'zh-CN-XiaoxiaoNeural';
        return API + '/tts'
            + '?text=' + encodeURIComponent(text)
            + '&voice=' + encodeURIComponent(voiceName)
            + '&rate=' + encodeURIComponent(toEdgeRate(utter && utter.rate))
            + '&pitch=' + encodeURIComponent(toEdgePitch(utter && utter.pitch))
            + '&volume=' + encodeURIComponent(toEdgeVolume(utter && utter.volume));
    }

    // ------------------------------------------------------------ Web Audio

    function getCtx() {
        if (play.ctx) {
            if (play.ctx.state === 'suspended' && !state.paused) {
                try { play.ctx.resume(); } catch (e) {}
            }
            return play.ctx;
        }
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try {
            play.ctx = new AC();
        } catch (e) {
            return null;
        }
        return play.ctx;
    }

    // 浏览器的自动播放策略：AudioContext 如果在用户手势之外创建会被挂起，
    // 表现是「点了朗读但没声音」。页面自动续读下一章时就可能踩到这个。
    // 这里在任何一次交互上补一次 resume，成本为零。
    (function armResume() {
        function onGesture() {
            if (play.ctx && play.ctx.state === 'suspended' && !state.paused) {
                try { play.ctx.resume(); } catch (e) {}
            }
        }
        var evs = ['pointerdown', 'mousedown', 'keydown', 'touchstart'];
        for (var i = 0; i < evs.length; i++) {
            try {
                document.addEventListener(evs[i], onGesture, true);
            } catch (e) {}
        }
    })();

    function sliceBuffer(ctx, buf, from, to) {
        var len = to - from;
        var out = ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
        for (var c = 0; c < buf.numberOfChannels; c++) {
            out.getChannelData(c).set(buf.getChannelData(c).subarray(from, to));
        }
        return out;
    }

    // 裁掉段首段尾多余的静音。
    // 这是「不连贯」的真正原因：每段自带 188ms 段首 + 538ms 段尾，
    // 首尾相接就是 726ms 没声音，七段下来 4.4 秒空白。
    function trimBuffer(ctx, buf) {
        var n = buf.length;
        var chs = [];
        for (var c = 0; c < buf.numberOfChannels; c++) {
            chs.push(buf.getChannelData(c));
        }

        function loud(i) {
            for (var c = 0; c < chs.length; c++) {
                if (Math.abs(chs[c][i]) > TRIM_THRESHOLD) return true;
            }
            return false;
        }

        var head = 0;
        while (head < n && !loud(head)) head++;
        if (head >= n) return null;          // 整段静音，直接丢掉

        var tail = n - 1;
        while (tail > head && !loud(tail)) tail--;

        var sr = buf.sampleRate;
        var from = Math.max(0, head - Math.round(sr * HEAD_KEEP));
        var to = Math.min(n, tail + 1 + Math.round(sr * TAIL_KEEP));
        if (to - from < sr * 0.05) return null;

        return sliceBuffer(ctx, buf, from, to);
    }

    function ensureDecoded(idx) {
        if (decoded[idx] !== undefined) {
            return Promise.resolve(decoded[idx]);
        }
        var ctx = getCtx();
        if (!ctx || !state.urls[idx]) {
            return Promise.resolve(null);
        }

        return fetch(state.urls[idx], { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('http ' + r.status);
                return r.arrayBuffer();
            })
            .then(function (ab) {
                // decodeAudioData 会「接管」传进去的 ArrayBuffer，传副本更稳
                return ctx.decodeAudioData(ab.slice(0));
            })
            .then(function (buf) {
                var t = trimBuffer(ctx, buf);
                decoded[idx] = t;
                return t;
            })
            .catch(function () {
                decoded[idx] = null;
                return null;
            });
    }

    // 串行预解码：同一时刻只有一个合成请求在跑。
    // 并发会互相抢资源（实测每段从 1.6s 拖到 2.8s），而串行完全跟得上播放。
    function pumpPrefetch() {
        if (state.cancelled || prefetching || !state.utter) return;
        var i = prefetchNext;
        if (i >= state.queue.length) return;
        if (i > play.next + AHEAD) return;    // 别跑太远，白占内存

        prefetching = true;
        ensureDecoded(i).then(function () {
            prefetching = false;
            if (prefetchNext <= i) prefetchNext = i + 1;
            pumpPrefetch();
        });
    }

    function pumpPlay() {
        var ctx = getCtx();
        if (!ctx || state.cancelled || !state.utter || play.running) return;
        play.running = true;

        // 游标落到过去（首段，或者中间被卡了一下）就重新对齐到现在
        if (play.cursor < ctx.currentTime) {
            play.cursor = ctx.currentTime + START_LEAD;
        }

        (function step() {
            if (state.cancelled || !state.utter) {
                play.running = false;
                return;
            }
            if (play.next >= state.queue.length) {
                play.running = false;
                maybeEnd();
                return;
            }
            // 已经排出去的段够听了，等播完再补，别一次把整章都塞进音频图
            if (play.scheduled - play.played >= AHEAD) {
                play.running = false;
                return;
            }

            var idx = play.next;
            ensureDecoded(idx).then(function (buf) {
                if (state.cancelled || !state.utter) {
                    play.running = false;
                    return;
                }
                if (!buf) {                  // 全静音或合成失败：跳过，别卡住
                    play.next++;
                    step();
                    return;
                }

                var when = Math.max(play.cursor, ctx.currentTime + 0.02);
                var src = ctx.createBufferSource();
                src.buffer = buf;
                src.connect(ctx.destination);

                try {
                    src.start(when);
                } catch (e) {
                    play.next++;
                    step();
                    return;
                }

                play.cursor = when + buf.duration;
                play.next++;
                play.scheduled++;
                play.sources.push(src);

                src.onended = function () {
                    play.played++;
                    try { src.disconnect(); } catch (e) {}
                    // 播完就释放这段 PCM。不释放的话长章节会一直攒，
                    // 48kHz float32 约 11.5MB/分钟，一小时能吃掉 700MB。
                    try { delete decoded[idx]; } catch (e) {}
                    for (var k = 0; k < play.sources.length; k++) {
                        if (play.sources[k] === src) { play.sources.splice(k, 1); break; }
                    }
                    pumpPlay();              // 播完一段补排下一段
                    maybeEnd();
                };

                pumpPrefetch();
                step();
            });
        })();
    }

    function maybeEnd() {
        if (state.cancelled || !state.utter) return;
        if (play.next < state.queue.length) return;
        if (play.played < play.scheduled) return;
        finish();
    }

    function finish() {
        var u = state.utter;
        state.utter = null;
        state.queue = [];
        state.urls = [];
        cleanup();
        fire(u, 'onend');
    }

    function cleanup() {
        for (var i = 0; i < play.sources.length; i++) {
            var s = play.sources[i];
            try { s.onended = null; } catch (e) {}
            try { s.stop(); } catch (e) {}
            try { s.disconnect(); } catch (e) {}
        }
        play.sources = [];
        play.next = 0;
        play.cursor = 0;
        play.scheduled = 0;
        play.played = 0;
        play.running = false;
        decoded = {};
        prefetching = false;
        prefetchNext = 0;
        stopAudio();
    }

    // ------------------------------------------------------------ 退路模式

    function stopAudio() {
        var a = state.audio;
        state.audio = null;
        if (!a) return;
        try {
            a.onended = null;
            a.onerror = null;
            a.pause();
            a.removeAttribute('src');
            a.load();
        } catch (e) {}
    }

    // 没有 Web Audio 时退回逐段 <audio>。接缝会比较明显（每段自带 700ms 静音），
    // 但至少能听，不至于整页不能朗读。
    function legacySpeak(utter) {
        var queue = splitText(utter.text);
        var i = 0;

        state.cancelled = false;
        state.paused = false;
        state.utter = utter;
        fire(utter, 'onstart');

        function next() {
            if (state.cancelled || i >= queue.length) {
                var u = state.utter;
                state.utter = null;
                stopAudio();
                if (!state.cancelled && u) fire(u, 'onend');
                return;
            }
            var a = new Audio(buildUrl(queue[i++], utter));
            a.preload = 'auto';
            state.audio = a;
            a.onended = next;
            a.onerror = next;
            var p = a.play();
            if (p && typeof p.catch === 'function') {
                p.catch(next);
            }
        }

        next();
    }

    // ------------------------------------------------------------ 对外接口

    synth.getVoices = function () {
        var native = nativeGetVoices() || [];
        return virtualVoices.concat(native);
    };

    synth.speak = function (utter) {
        if (!utter || typeof utter.text !== 'string' || !utter.text.trim()) {
            return;
        }

        var isVirtual = !!(utter.__ttsEdge || edgeNameOf(utter.voice));
        if (!isVirtual) {
            return nativeSpeak(utter);
        }

        synth.cancel();

        if (!getCtx()) {
            return legacySpeak(utter);
        }

        state.cancelled = false;
        state.paused = false;
        state.queue = splitText(utter.text);
        state.urls = state.queue.map(function (t) { return buildUrl(t, utter); });
        state.utter = utter;
        state.seq++;

        play.next = 0;
        play.cursor = 0;
        play.scheduled = 0;
        play.played = 0;
        play.sources = [];
        play.running = false;
        decoded = {};
        prefetching = false;
        prefetchNext = 0;

        fire(utter, 'onstart');
        pumpPrefetch();
        pumpPlay();
    };

    synth.cancel = function () {
        state.cancelled = true;
        state.paused = false;
        state.queue = [];
        state.urls = [];
        state.utter = null;
        state.seq++;
        cleanup();
        try { nativeCancel(); } catch (e) {}
    };

    synth.pause = function () {
        state.paused = true;
        if (play.ctx && play.ctx.state === 'running') {
            try { play.ctx.suspend(); } catch (e) {}
        }
        if (state.audio) {
            try { state.audio.pause(); } catch (e) {}
        }
        try { nativePause(); } catch (e) {}
    };

    synth.resume = function () {
        state.paused = false;
        if (play.ctx && play.ctx.state === 'suspended') {
            try { play.ctx.resume(); } catch (e) {}
        }
        if (state.audio) {
            try { state.audio.play(); } catch (e) {}
        }
        try { nativeResume(); } catch (e) {}
    };

    function notify() {
        synth.__ttsBridge = true;
        try {
            if (typeof synth.onvoiceschanged === 'function') synth.onvoiceschanged();
        } catch (e) {}
        try {
            window.dispatchEvent(new Event('voiceschanged'));
        } catch (e) {}
    }

    function loadVoices(attempt) {
        var delay = RETRY_DELAYS[attempt];
        if (delay === undefined) {
            return;
        }
        setTimeout(function () {
            fetch(API + '/voices', { cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    window.__bridgeData = d;
                    if (!d || !d.ok || !d.voices || !d.voices.length) {
                        // 服务在跑但音色列表还没准备好（预热中），再等一轮
                        window.__bridgeError = 'empty payload';
                        loadVoices(attempt + 1);
                        return;
                    }
                    var sample = (nativeGetVoices() || [])[0] || null;
                    virtualVoices = d.voices.map(function (v) { return buildVoice(v, sample); });
                    notify();
                })
                .catch(function (e) {
                    // 服务没起，或者还没起完。安静重试，页面照旧用系统音色。
                    window.__bridgeError = String(e);
                    loadVoices(attempt + 1);
                });
        }, delay);
    }

    loadVoices(0);
})();
