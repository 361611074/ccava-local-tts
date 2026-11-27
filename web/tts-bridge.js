/**
 * 在线音色适配层  ·  漫步白月光  https://www.ccava.net/
 *
 * 浏览器原生的 speechSynthesis 只能读系统 SAPI5 音色，Windows 上中文就 1~4 个。
 * 这段脚本在页面加载后接管 speechSynthesis，把本地 TTS 服务提供的在线音色
 * 混进音色列表，朗读时改用服务合成的音频播放。
 *
 * 不依赖任何框架。原生音色照旧走浏览器，只有虚拟音色走本地服务。
 *
 * v4 针对卡顿的三处改动：
 *   1. 首段切短（80 字），后面才用 280 字 —— 点下朗读能更快出声
 *   2. 播当前段的同时预取下一段（存成 blob），段与段之间不再等合成
 *   3. 音色列表重试次数加长，服务刚开机预热慢时也能等到
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

    // 首段短、后续长：首段 80 字合成约 0.5 秒就能出声，
    // 后面每段 280 字，配合预取，段与段之间听不出停顿。
    var FIRST_CHUNK = 80;
    var MAX_CHUNK = 280;

    // 开机后服务可能还在预热，页面就打开了。失败时多试几次，别一次失败就放弃。
    var RETRY_DELAYS = [0, 1000, 2000, 3000, 5000, 8000, 12000, 15000, 20000];

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
        seq: 0
    };

    // 预取缓存：index -> { blobUrl, done, failed }
    var prefetched = {};

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

    function releasePrefetch() {
        for (var k in prefetched) {
            if (Object.prototype.hasOwnProperty.call(prefetched, k)) {
                var it = prefetched[k];
                if (it && it.blobUrl) {
                    try { URL.revokeObjectURL(it.blobUrl); } catch (e) {}
                }
            }
        }
        prefetched = {};
    }

    // 提前把第 idx 段合成好、下载成 blob，播放时就不用等
    function prefetchAt(idx) {
        if (idx >= state.queue.length || prefetched[idx]) return;
        var item = { blobUrl: null, done: false };
        prefetched[idx] = item;
        var url = buildUrl(state.queue[idx], state.utter);
        fetch(url, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('http ' + r.status);
                return r.blob();
            })
            .then(function (b) {
                item.blobUrl = URL.createObjectURL(b);
                item.done = true;
            })
            .catch(function () {
                item.done = true;
                item.failed = true;
            });
    }

    function playNext() {
        if (state.cancelled || state.index >= state.queue.length) {
            var u = state.utter;
            state.utter = null;
            stopAudio();
            releasePrefetch();
            if (!state.cancelled) {
                fire(u, 'onend');
            }
            return;
        }

        // 上一段必须先彻底停掉，否则出错时两段音频会叠在一起响
        stopAudio();

        var utter = state.utter;
        var idx = state.index++;
        var text = state.queue[idx];
        var seq = ++state.seq;

        // 预取好了就用 blob，省掉一次网络往返和解码前的等待
        var item = prefetched[idx];
        var useBlob = !!(item && item.blobUrl);
        var url = useBlob ? item.blobUrl : buildUrl(text, utter);

        var audio = new Audio(url);
        audio.preload = 'auto';
        state.audio = audio;

        // 序号对不上说明这条回调来自上一段，直接丢弃，避免重复推进队列
        function advance() {
            if (state.cancelled || state.seq !== seq) return;
            if (useBlob && item && item.blobUrl) {
                try { URL.revokeObjectURL(item.blobUrl); } catch (e) {}
                item.blobUrl = null;
            }
            playNext();
        }

        audio.onended = advance;
        audio.onerror = advance;

        var p = audio.play();
        if (p && typeof p.catch === 'function') {
            p.catch(advance);
        }

        // 预取下一段要等一会儿再发。立刻发会和当前段抢合成资源
        // （实测并发时每段都从 1.6s 拖到 2.8s，首段要多等 2 秒才出声）。
        // 800ms 足够当前段把请求送出去，而下一段离播放还有十几秒，完全来得及。
        var nextIdx = state.index;
        setTimeout(function () {
            if (state.cancelled || state.seq !== seq) return;
            prefetchAt(nextIdx);
        }, 800);
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
        state.queue = [];
        state.index = 0;
        state.utter = null;
        state.seq++;
        stopAudio();
        releasePrefetch();
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
        if (state.audio) {
            try { state.audio.play(); } catch (e) {}
            state.paused = false;
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
