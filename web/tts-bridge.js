/**
 * 在线音色适配层  ·  漫步白月光  https://www.ccava.net/
 *
 * 浏览器原生的 speechSynthesis 只能读系统 SAPI5 音色，Windows 上中文就 1~4 个。
 * 这段脚本在页面加载后接管 speechSynthesis，把本地 TTS 服务提供的在线音色
 * 混进音色列表，朗读时改用服务合成的音频播放。
 *
 * 不依赖任何框架。原生音色照旧走浏览器，只有虚拟音色走本地服务。
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

    // 单段字数。太长会等很久才出声，太短会让请求数暴增，280 是个平衡点。
    var MAX_CHUNK = 280;

    // 首段单独切短：第一句说完就出声，别让用户干等一秒多。
    var FIRST_CHUNK = 80;

    // 提前合成后面几块。这样一块播完时下一块已经在内存里，切换不用再等网络。
    // 每块大约一分钟音频，提前 2 块足够覆盖任何抖动，也能在一块失败时留个备胎。
    var PREFETCH = 2;

    // 开机自启时服务要预热（拉一次微软音色列表），页面可能比服务先打开。
    // 前几次密一点，之后就低频补，别让用户非得手动刷新页面才能看到在线音色。
    var RETRY_DELAYS = [0, 800, 1500, 2500, 4000, 6000, 8000, 10000, 12000];
    var RETRY_TAIL = 5000;      // 表走完后每隔多久再试
    var RETRY_MAX = 48;         // 兜底上限，约 4 分钟，避免服务没装时无限重试

    var nativeGetVoices = synth.getVoices.bind(synth);
    var nativeSpeak = synth.speak.bind(synth);
    var nativeCancel = synth.cancel.bind(synth);
    var nativePause = synth.pause.bind(synth);
    var nativeResume = synth.resume.bind(synth);

    var virtualVoices = [];

    var state = {
        audio: null,
        queue: [],
        index: 0,
        utter: null,
        cancelled: false,
        paused: false,
        // session 管一次朗读的全程，cancel 或重新 speak 时递增；
        // seq 管单块，用来丢掉过期的播放回调。两者不能混用——
        // 预取是跨块的，如果拿 seq 校验，下一块一开始预取结果就全废了。
        session: 0,
        seq: 0,
        cache: {},      // 块序号 -> Promise<blob URL>
        ctrls: {},      // 块序号 -> AbortController
        urls: []        // 所有 createObjectURL 的结果，统一回收
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

    var SENTENCE_END = /[。！？；：…\n]/;

    function splitText(text) {
        var s = String(text);
        var out = [];

        // 首块只取到第一句结束，通常 20~60 字。合成一次不到一秒就能出声，
        // 用户点下去马上有反应，不用盯着屏幕等。
        if (s.length > FIRST_CHUNK) {
            for (var k = 0; k < FIRST_CHUNK; k++) {
                if (SENTENCE_END.test(s.charAt(k))) {
                    out.push(s.slice(0, k + 1));
                    s = s.slice(k + 1);
                    break;
                }
            }
        }

        var buf = '';
        var parts = s.split(/(?<=[。！？；：…\n])/);

        for (var i = 0; i < parts.length; i++) {
            var piece = parts[i];
            if (!piece) continue;

            if (buf && buf.length + piece.length > MAX_CHUNK) {
                out.push(buf);
                buf = piece;
            } else {
                buf += piece;
            }

            while (buf.length > MAX_CHUNK) {
                var cut = buf.lastIndexOf('，', MAX_CHUNK);
                if (cut < MAX_CHUNK * 0.4) cut = MAX_CHUNK;
                out.push(buf.slice(0, cut));
                buf = buf.slice(cut);
            }
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

    function ttsUrl(utter, text) {
        var voiceName = (utter && utter.__ttsEdge)
            || edgeNameOf(utter && utter.voice)
            || 'zh-CN-XiaoxiaoNeural';

        return API + '/tts'
            + '?text=' + encodeURIComponent(text)
            + '&voice=' + encodeURIComponent(voiceName)
            + '&rate=' + encodeURIComponent(toEdgeRate(utter && utter.rate))
            + '&pitch=' + encodeURIComponent(toEdgePitch(utter && utter.pitch))
            + '&volume=' + encodeURIComponent(toEdgeVolume(utter && utter.volume));
    }

    function revokeOne(url) {
        if (typeof url !== 'string' || url.indexOf('blob:') !== 0) return;
        try { URL.revokeObjectURL(url); } catch (e) {}
        var i = state.urls.indexOf(url);
        if (i >= 0) state.urls.splice(i, 1);
    }

    function stopAudio() {
        var a = state.audio;
        state.audio = null;
        if (!a) return;
        var src = '';
        try { src = a.src || ''; } catch (e) {}
        try {
            a.onended = null;
            a.onerror = null;
            a.pause();
            a.removeAttribute('src');
            a.load();
        } catch (e) {}
        // 播完或被打断的音频要立刻把 Blob 释放掉，不然长章节会一直攒内存
        revokeOne(src);
    }

    // 一次朗读结束或被取消时，把没来得及播的预取全部清干净
    function resetPipeline() {
        for (var k in state.ctrls) {
            try { state.ctrls[k].abort(); } catch (e) {}
        }
        state.ctrls = {};
        state.cache = {};

        for (var i = 0; i < state.urls.length; i++) {
            try { URL.revokeObjectURL(state.urls[i]); } catch (e) {}
        }
        state.urls = [];
    }

    function fetchChunk(session, idx, text, utter) {
        if (state.cache[idx]) return state.cache[idx];

        var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        if (ctrl) state.ctrls[idx] = ctrl;

        var p = fetch(ttsUrl(utter, text), {
            cache: 'no-store',
            signal: ctrl ? ctrl.signal : undefined
        }).then(function (r) {
            if (!r.ok) throw new Error('tts http ' + r.status);
            return r.blob();
        }).then(function (blob) {
            // 会话已经换了（用户点了别的段落），这份音频作废
            if (state.session !== session) return null;
            var url = URL.createObjectURL(blob);
            state.urls.push(url);
            return url;
        });

        // 失败别把坏 Promise 钉死在缓存里，下一轮还能重试
        p.catch(function () {
            if (state.cache[idx] === p) delete state.cache[idx];
            delete state.ctrls[idx];
        });

        state.cache[idx] = p;
        return p;
    }

    // 把后面几块一次性排进合成队列。这是解决「读一会卡一下」的关键：
    // 卡顿的根因是「上一块播完才开始请求下一块」，中间空等一次完整合成时间。
    function prefetchAhead(session) {
        if (!state.utter) return;
        for (var k = 0; k < PREFETCH; k++) {
            var i = state.index + k;
            if (i >= state.queue.length) break;
            if (state.cache[i]) continue;
            fetchChunk(session, i, state.queue[i], state.utter);
        }
    }

    function playNext() {
        if (state.cancelled || state.index >= state.queue.length) {
            var u = state.utter;
            state.utter = null;
            stopAudio();
            resetPipeline();
            if (!state.cancelled) {
                fire(u, 'onend');
            }
            return;
        }

        // 上一段必须先彻底停掉，否则出错时两段音频会叠在一起响
        stopAudio();

        var session = state.session;
        var utter = state.utter;
        var idx = state.index++;
        var text = state.queue[idx];
        var seq = ++state.seq;

        function advance() {
            if (state.cancelled || state.seq !== seq) return;
            playNext();
        }

        function start(src) {
            if (state.cancelled || state.seq !== seq || state.session !== session) return;
            var audio = new Audio();
            audio.src = src;
            state.audio = audio;
            audio.onended = advance;
            audio.onerror = advance;
            // 这一块已经就位，现在才去预取后面的。反过来的话首块会跟预取抢带宽，
            // 用户反而要多等半秒才听到声音。每块有一分钟音频，晚一两秒预取完全来得及。
            prefetchAhead(session);
            // 合成期间用户按了暂停，就先挂上 src 等着，等 resume 再出声
            if (state.paused) return;
            var p = audio.play();
            if (p && typeof p.catch === 'function') {
                p.catch(advance);
            }
        }

        var ready = state.cache[idx] || fetchChunk(session, idx, text, utter);

        ready.then(function (url) {
            if (!url) return;
            delete state.cache[idx];
            delete state.ctrls[idx];
            start(url);
        }).catch(function () {
            // 预取挂了就退回直连，让浏览器自己去拉，至少还能出声
            if (state.session !== session) return;
            delete state.cache[idx];
            start(ttsUrl(utter, text));
        });
    }

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
        state.cancelled = false;
        state.paused = false;
        state.queue = splitText(utter.text);
        state.index = 0;
        state.utter = utter;

        fire(utter, 'onstart');
        playNext();
    };

    synth.cancel = function () {
        state.cancelled = true;
        state.paused = false;
        state.session++;
        state.seq++;
        state.queue = [];
        state.index = 0;
        state.utter = null;
        // 先停正在响的，再回收其余预取，顺序不能反
        stopAudio();
        resetPipeline();
        try { nativeCancel(); } catch (e) {}
    };

    synth.pause = function () {
        if (state.audio) {
            try { state.audio.pause(); } catch (e) {}
            state.paused = true;
        }
        try { nativePause(); } catch (e) {}
    };

    synth.resume = function () {
        state.paused = false;
        if (state.audio) {
            try { state.audio.play(); } catch (e) {}
        }
        try { nativeResume(); } catch (e) {}
    };

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
            if (attempt > RETRY_MAX) return;
            delay = RETRY_TAIL;
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
