/* AI coach transport: dedicated worker only; input and rendering stay on the main thread. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PixelCoachClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  class Controller {
    constructor(options = {}) {
      this.onResult = typeof options.onResult === 'function' ? options.onResult : () => {};
      this.onError = typeof options.onError === 'function' ? options.onError : () => {};
      this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
      this.Worker = options.Worker === undefined ? root.Worker : options.Worker;
      this.Blob = options.Blob === undefined ? root.Blob : options.Blob;
      this.URL = options.URL === undefined ? root.URL : options.URL;
      this.workerURL = options.workerURL || 'coach-worker.js';
      this.workerSource = options.workerSource === undefined ? root.PIXEL_COACH_WORKER_SOURCE : options.workerSource;
      this.analysisOptions = options.analysisOptions || {};
      this.worker = null;
      this.objectURL = null;
      this.inflight = null;
      this.pending = null;
      this.latestKey = undefined;
      this.completedKey = undefined;
      this.sequence = 0;
      this.generation = 0;
      this.destroyed = false;
      this.failed = false;
      this.status = 'idle';
    }

    request(view, key, options) {
      if (this.destroyed || this.failed) return false;
      if (key === undefined) key = ++this.sequence;
      // Keys describe the complete playable position. Repeated animation frames
      // must not create a queue of identical searches.
      if (key === this.latestKey && (this.inflight || key === this.completedKey)) return false;
      this.latestKey = key;
      if (this.inflight?.key === key) {this.pending = null; return true;}
      let snapshot;
      try {snapshot = JSON.parse(JSON.stringify(view));}
      catch (error) {this._fail(error, key); return false;}
      const request = {id: ++this.sequence, key, view: snapshot, options: options || this.analysisOptions};
      if (this.inflight) {this.pending = request; return true;}
      return this._dispatch(request);
    }

    _setStatus(status) {
      if (this.status === status) return;
      this.status = status;
      this.onStatus(status);
    }

    _ensureWorker() {
      if (this.worker) return;
      if (typeof this.Worker !== 'function') throw new Error('此环境不支持后台计算，AI 教练暂不可用。');
      let sourceURL = this.workerURL;
      // The desktop and direct-file browser build preload a self-contained
      // script string. Blob workers do not fetch file:// scripts or use the network.
      if (typeof this.workerSource === 'string' && this.workerSource.length &&
          typeof this.Blob === 'function' && typeof this.URL?.createObjectURL === 'function') {
        this.objectURL = this.URL.createObjectURL(new this.Blob([this.workerSource], {type: 'text/javascript'}));
        sourceURL = this.objectURL;
      }
      const worker = new this.Worker(sourceURL);
      const generation = this.generation;
      this.worker = worker;
      worker.onmessage = event => {
        if (generation !== this.generation || worker !== this.worker) return;
        this._receive(event.data);
      };
      worker.onerror = event => {
        if (generation !== this.generation || worker !== this.worker) return;
        if (typeof event?.preventDefault === 'function') event.preventDefault();
        this._fail(new Error(event?.message || 'AI 教练的后台计算未能启动。'), this.latestKey);
      };
      worker.onmessageerror = () => {
        if (generation === this.generation && worker === this.worker)
          this._fail(new Error('AI 教练返回了无法读取的结果。'), this.latestKey);
      };
    }

    _dispatch(request) {
      try {
        this._ensureWorker();
        this.inflight = request;
        this._setStatus('thinking');
        this.worker.postMessage({id: request.id, view: request.view, options: request.options});
        return true;
      } catch (error) {this._fail(error, request.key); return false;}
    }

    _receive(message) {
      const current = this.inflight;
      if (!current || !message || message.id !== current.id) return;
      this.inflight = null;
      if (message.error) {
        // An invalid old position must not hide a newer valid recommendation.
        if (current.key === this.latestKey) {
          this._fail(new Error(String(message.error)), current.key);
          return;
        }
      } else if (current.key === this.latestKey) {
        this.completedKey = current.key;
        this._setStatus('idle');
        this.onResult(message.result, current.key);
      }
      const pending = this.pending;
      this.pending = null;
      // Callbacks may cancel, destroy, or submit another position.
      if (!this.destroyed && !this.failed && !this.inflight && pending && pending.key === this.latestKey)
        this._dispatch(pending);
      else if (!this.inflight && !this.failed && !this.destroyed) this._setStatus('idle');
    }

    _releaseWorker() {
      this.generation++;
      if (this.worker) {
        this.worker.onmessage = null;
        this.worker.onerror = null;
        this.worker.onmessageerror = null;
        this.worker.terminate();
        this.worker = null;
      }
      if (this.objectURL !== null) {
        this.URL.revokeObjectURL(this.objectURL);
        this.objectURL = null;
      }
    }

    _fail(error, key) {
      this._releaseWorker();
      this.inflight = this.pending = null;
      this.failed = true;
      this._setStatus('unavailable');
      this.onError(error instanceof Error ? error : new Error(String(error)), key);
    }

    cancel() {
      this._releaseWorker();
      this.inflight = this.pending = null;
      this.latestKey = this.completedKey = undefined;
      this.failed = false;
      if (!this.destroyed) this._setStatus('idle');
    }

    destroy() {
      if (this.destroyed) return;
      this.cancel();
      this.destroyed = true;
      this._setStatus('destroyed');
    }
  }

  return {Controller};
});
