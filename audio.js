/* Original offline pixel sounds. No samples, downloads, timers, or decoding on play. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PixelAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const EVENTS = Object.freeze([
    ['move', '左右移动'], ['rotate', '旋转'], ['softdrop', '软降'],
    ['harddrop', '硬降'], ['hold', '暂存'], ['lock', '方块落定'],
    ['clear', '普通消行'], ['tetris', '四行消除'], ['tspin', 'T-Spin'],
    ['combo', '连击'], ['perfect', '全消'], ['level', '升级'],
    ['pause', '暂停'], ['resume', '继续'], ['start', '开始 / 重开'],
    ['undo', '撤销'], ['win', '模式完成'], ['gameover', '游戏结束']
  ].map(([id, label]) => Object.freeze({id, label})));

  // A note is [start, duration, frequency, endFrequency, waveform, amplitude].
  const LIBRARY = {
    silence: {label: '无声', duration: 0, notes: []},
    click: {label: '像素 · 咔嗒', duration: .028, notes: [[0,.028,1280,960,'square',1]]},
    tick: {label: '像素 · 轻点', duration: .036, notes: [[0,.036,1800,1400,'triangle',1]]},
    pop: {label: '像素 · 啵', duration: .065, notes: [[0,.065,720,280,'sine',1]]},
    up: {label: '像素 · 上扬', duration: .102, notes: [[0,.049,660,660,'square',.8],[.042,.06,990,990,'square',.8]]},
    down: {label: '像素 · 下落', duration: .105, notes: [[0,.05,740,740,'triangle',1],[.045,.06,490,490,'triangle',1]]},
    drop: {label: '街机 · 重落', duration: .12, notes: [[0,.12,155,45,'triangle',1],[0,.037,0,0,'noise',.35]]},
    thud: {label: '街机 · 低鼓', duration: .095, notes: [[0,.095,105,42,'sine',1],[0,.022,0,0,'noise',.17]]},
    clear: {label: '街机 · 三连音', duration: .215, notes: [[0,.075,523,523,'square',.75],[.065,.075,659,659,'square',.75],[.13,.085,784,784,'square',.75]]},
    fanfare: {label: '街机 · 四连音', duration: .355, notes: [[0,.08,523,523,'square',.7],[.07,.08,659,659,'square',.7],[.14,.08,784,784,'square',.7],[.21,.145,1047,1047,'square',.7]]},
    coin: {label: '街机 · 金币', duration: .18, notes: [[0,.045,988,988,'square',.8],[.038,.142,1319,1319,'square',.8]]},
    sparkle: {label: '晶片 · 闪烁', duration: .285, notes: [[0,.13,1320,1320,'sine',1],[.065,.13,1760,1760,'sine',.85],[.13,.155,2640,2640,'sine',.7]]},
    laser: {label: '晶片 · 激光', duration: .145, notes: [[0,.145,1100,180,'saw',.8]]},
    zap: {label: '晶片 · 电击', duration: .09, notes: [[0,.09,480,80,'square',.85]]},
    level: {label: '晶片 · 升级', duration: .34, notes: [[0,.1,523,523,'pulse',.7],[.085,.1,784,784,'pulse',.7],[.17,.17,1047,1047,'pulse',.7]]},
    alert: {label: '晶片 · 双响', duration: .25, notes: [[0,.105,220,220,'square',.7],[.145,.105,220,220,'square',.7]]},
    soft: {label: '柔和 · 木音', duration: .065, notes: [[0,.065,350,220,'triangle',1]]},
    bell: {label: '柔和 · 铃音', duration: .26, notes: [[0,.26,880,880,'sine',1],[0,.145,1760,1760,'sine',.3]]},
    digital: {label: '晶片 · 跳音', duration: .18, notes: [[0,.065,880,880,'pulse',.7],[.055,.065,660,660,'pulse',.7],[.11,.07,990,990,'pulse',.7]]},
    rewind: {label: '街机 · 回溯', duration: .18, notes: [[0,.07,1047,1047,'triangle',1],[.055,.07,740,740,'triangle',1],[.11,.07,523,523,'triangle',1]]},
    victory: {label: '街机 · 胜利', duration: .49, notes: [[0,.09,523,523,'square',.7],[.08,.09,659,659,'square',.7],[.16,.09,784,784,'square',.7],[.24,.25,1047,1047,'square',.7]]},
    over: {label: '街机 · 结束', duration: .39, notes: [[0,.14,392,392,'triangle',1],[.115,.14,311,311,'triangle',1],[.23,.16,196,130,'triangle',1]]}
  };
  const PRESETS = Object.freeze(Object.entries(LIBRARY).map(([id, preset]) => Object.freeze({id, label: preset.label})));
  const DEFAULT_MAP = Object.freeze({
    move: 'click', rotate: 'up', softdrop: 'tick', harddrop: 'drop', hold: 'down',
    lock: 'thud', clear: 'clear', tetris: 'fanfare', tspin: 'digital', combo: 'coin',
    perfect: 'sparkle', level: 'level', pause: 'down', resume: 'up', start: 'digital',
    undo: 'rewind', win: 'victory', gameover: 'over'
  });
  const hasPreset = id => typeof id === 'string' && Object.prototype.hasOwnProperty.call(LIBRARY, id);

  function normalizeConfig(input) {
    input = input && typeof input === 'object' ? input : {};
    const map = {};
    for (const {id} of EVENTS) map[id] = hasPreset(input.map?.[id]) ? input.map[id] : DEFAULT_MAP[id];
    return {volume: Number.isFinite(input.volume) ? Math.max(0, Math.min(100, input.volume)) : 60, map};
  }

  function renderBuffer(context, preset, seed) {
    const rate = context.sampleRate;
    const buffer = context.createBuffer(1, Math.max(1, Math.ceil(preset.duration * rate)), rate);
    const samples = buffer.getChannelData(0);
    let random = seed + 1;
    for (const [start, duration, frequency, endFrequency, wave, amplitude] of preset.notes) {
      const begin = Math.round(start * rate);
      const count = Math.min(Math.ceil(duration * rate), samples.length - begin);
      let phase = 0, filtered = 0;
      const cutoff = Math.min(8500, rate * .2);
      const filterMix = 1 - Math.exp(-2 * Math.PI * cutoff / rate);
      for (let i = 0; i < count; i++) {
        const time = i / rate, progress = time / duration;
        const hz = frequency > 0 ? frequency * Math.pow(endFrequency / frequency, progress) : 0;
        phase = (phase + hz / rate) % 1;
        let sample;
        if (wave === 'noise') {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          sample = random / 2147483648 - 1;
        } else if (wave === 'square') sample = phase < .5 ? 1 : -1;
        else if (wave === 'pulse') sample = phase < .25 ? 1 : -1 / 3;
        else if (wave === 'saw') sample = 2 * phase - 1;
        else if (wave === 'triangle') sample = 1 - 4 * Math.abs(phase - .5);
        else sample = Math.sin(2 * Math.PI * phase);
        filtered += filterMix * (sample - filtered);
        // <1 ms attack prevents a click while remaining effectively immediate.
        const attack = Math.min(1, time / .0007);
        const release = Math.max(0, Math.min(1, (count - 1 - i) / (rate * .006)));
        const envelope = attack * release * Math.exp(-3 * progress);
        samples[begin + i] += filtered * envelope * amplitude;
      }
    }
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    if (peak > 0) {
      const scale = .44 / peak;
      for (let i = 0; i < samples.length; i++) samples[i] *= scale;
    }
    return buffer;
  }

  class SoundEngine {
    constructor(options = {}) {
      this._AudioContext = options.AudioContext || root.AudioContext || root.webkitAudioContext;
      this._nativeBridge = options.nativeBridge || (root.PixelNativeAudio === true ? root.webkit?.messageHandlers?.pixelAudio : null);
      this._nativeUnlocked = false;
      this._enabled = options.enabled !== false;
      this._active = true;
      this._now = options.now || (() => root.performance?.now?.() ?? Date.now());
      this.config = normalizeConfig(options.config);
      this.context = null;
      this.master = null;
      this.buffers = new Map();
      this._voices = [];
      this._lastRepeat = new Map();
      this._resumePending = null;
      this._played = 0;
      this._available = Boolean(this._nativeBridge || this._AudioContext);
      if (this._nativeBridge) root.addEventListener?.('pixelAudioUnavailable', () => {
        this._nativeBridge = null;
        this._nativeUnlocked = false;
        this._available = Boolean(this._AudioContext);
        this.unlock(false);
      });
    }

    _sendNative(message) {
      if (!this._nativeBridge) return false;
      try { this._nativeBridge.postMessage(message); return true; }
      catch (_) { this._nativeBridge = null; this._nativeUnlocked = false; return false; }
    }

    configure(config) {
      const wasAudible = this._audible();
      this.config = normalizeConfig(config);
      this._sendNative({command:'configure', volume:this.config.volume, enabled:this._audible()});
      if (this.context && this.master) {
        const gain = this.master.gain, time = this.context.currentTime;
        gain.cancelScheduledValues(time);
        gain.setTargetAtTime(this.config.volume / 100 * .23, time, .005);
      }
      if (!this._audible()) this._suspendBrowser();
      else if (this.context || !wasAudible) this.unlock(false);
      return this.config;
    }

    // Prepare on explicit enable / foreground entry, before the next game key.
    // Muting and backgrounding retain PCM caches but stop the audio device.
    setEnabled(value) {
      this._enabled = value === true;
      this._updateActivity();
    }

    setActive(value) {
      this._active = value === true;
      this._updateActivity();
    }

    _audible() { return this._enabled && this._active && this.config.volume > 0; }

    _updateActivity() {
      const enabled = this._audible();
      this._sendNative({command:'configure', volume:this.config.volume, enabled});
      if (enabled) this.unlock(false);
      else {
        this._nativeUnlocked = false;
        this._lastRepeat.clear();
        this._suspendBrowser();
      }
    }

    _suspendBrowser() {
      this._nativeUnlocked = false;
      this._lastRepeat.clear();
      // A resume requested before this suspension must not block the next one.
      this._resumePending = null;
      if (!this.context) return;
      // End tails now: suspending their timeline alone would replay them on wake.
      for (const voice of this._voices.splice(0)) {
        voice.source.onended = null;
        try { voice.source.stop(this.context.currentTime); } catch (_) {}
        try { voice.source.disconnect(); voice.gain.disconnect(); } catch (_) {}
      }
      if (this.context.state !== 'closed' && typeof this.context.suspend === 'function') {
        try {
          const result = this.context.suspend();
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (_) {}
      }
    }

    // Public calls belong in key/pointer input; internal prewarming passes false.
    // Autoplay policy can leave a startup resume pending until a user gesture.
    // A real input must retry within that gesture rather than await the old call.
    unlock(fromInput = true) {
      if (!this._available || !this._audible()) return false;
      if (this._nativeBridge) {
        if (this._nativeUnlocked || this._sendNative({command:'warm'})) {
          this._nativeUnlocked = true;
          return true;
        }
      }
      if (!this._AudioContext) return false;
      try {
        if (!this.context || this.context.state === 'closed') {
          this.context = new this._AudioContext({latencyHint: 'interactive'});
          this.master = this.context.createGain();
          this.master.gain.setValueAtTime(this.config.volume / 100 * .23, this.context.currentTime);
          this.master.connect(this.context.destination);
          this.buffers.clear();
          this._voices = [];
          this._lastRepeat.clear();
          this._resumePending = null;
          let index = 0;
          for (const [id, preset] of Object.entries(LIBRARY)) {
            if (id !== 'silence') this.buffers.set(id, renderBuffer(this.context, preset, index++));
          }
        }
        if (this.context.state !== 'running' && (fromInput || !this._resumePending)) {
          const result = this.context.resume();
          if (result && typeof result.then === 'function') {
            const pending = Promise.resolve(result).catch(() => {}).finally(() => {
              if (this._resumePending === pending) this._resumePending = null;
            });
            this._resumePending = pending;
          }
        }
        return true;
      } catch (_) { return false; }
    }

    play(event) {
      const presetId = this.config.map[event];
      if (!this._audible() || !hasPreset(presetId) || presetId === 'silence') return false;
      if (event === 'move' || event === 'softdrop') {
        const now = this._now(), previous = this._lastRepeat.get(event);
        if (previous !== undefined && now - previous < 20) return false;
        if (!this._playPreset(presetId, event)) return false;
        this._lastRepeat.set(event, now);
        return true;
      }
      return this._playPreset(presetId, event);
    }

    preview(presetId) { return hasPreset(presetId) && this._playPreset(presetId); }

    stop(event) {
      if (typeof event !== 'string') return 0;
      // A new successful descent may happen immediately after moving off a
      // ledge. Cancelling old tails must not throttle that next cue.
      this._lastRepeat.delete(event);
      if (this._nativeBridge) return this._sendNative({command:'stop',event}) ? 1 : 0;
      const voices = this._voices.filter(voice => voice.event === event);
      this._voices = this._voices.filter(voice => voice.event !== event);
      for (const voice of voices) this._fadeVoice(voice);
      return voices.length;
    }

    _fadeVoice(voice) {
      if (voice.stopping) return;
      voice.stopping = true;
      try {
        const time = this.context.currentTime;
        voice.gain.gain.cancelScheduledValues(time);
        voice.gain.gain.setValueAtTime(1, time);
        voice.gain.gain.linearRampToValueAtTime(0, time + .003);
        voice.source.stop(time + .004);
      } catch (_) {}
    }

    _playPreset(presetId, event) {
      if (!this._audible() || presetId === 'silence') return false;
      if (this._nativeBridge) {
        if (this._sendNative({command:'play',preset:presetId,event:event || 'preview',volume:this.config.volume})) {
          this._played++;
          return true;
        }
        // If the native bridge fails, prepare the browser fallback in this same input.
        this.unlock(false);
      }
      if (!this.context || this.context.state === 'closed') return false;
      const buffer = this.buffers.get(presetId);
      if (!buffer) return false;
      try {
        const context = this.context, time = context.currentTime;
        // Eight .44-peak voices through a .23 master stay below full scale.
        // Fade the oldest voice over 3 ms if a busy sequence reaches the cap.
        if (this._voices.length >= 8) {
          const oldest = this._voices.shift();
          this._fadeVoice(oldest);
        }
        const source = context.createBufferSource(), gain = context.createGain();
        source.buffer = buffer;
        source.connect(gain);
        gain.connect(this.master);
        const voice = {source, gain, event, stopping:false};
        this._voices.push(voice);
        source.onended = () => {
          const index = this._voices.indexOf(voice);
          if (index >= 0) this._voices.splice(index, 1);
          source.disconnect();
          gain.disconnect();
        };
        source.start(time);
        this._played++;
        return true;
      } catch (_) { return false; }
    }

    stats() {
      return {
        available: this._available,
        backend: this._nativeBridge ? 'native' : 'webaudio',
        state: !this._audible() ? 'suspended' : this._nativeBridge ? 'running' : this.context?.state || 'locked',
        cachedBuffers: this._nativeBridge ? PRESETS.length - 1 : this.buffers.size,
        played: this._played,
        activeVoices: this._voices.length,
        baseLatency: Number.isFinite(this.context?.baseLatency) ? this.context.baseLatency : null,
        outputLatency: Number.isFinite(this.context?.outputLatency) ? this.context.outputLatency : null
      };
    }
  }

  return Object.freeze({EVENTS, PRESETS, DEFAULT_MAP, normalizeConfig, SoundEngine});
});
