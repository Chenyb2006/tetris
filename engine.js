/* Pixel Stack engine — standalone, dependency-free, deterministic rules. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PixelEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COLS = 10, ROWS = 24, HIDDEN_ROWS = 4, VERSION = 1, MAX_UNDOS = 30;
  const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  const MODES = ['marathon', 'sprint', 'ultra', 'zen', 'classic', 'training'];
  const COLORS = { I: '#6bd9df', O: '#e9cf71', T: '#bb92df', S: '#9ccf8c', Z: '#e78e93', J: '#839edb', L: '#e6b17d' };
  const SPAWN = {
    I: [[0,1],[1,1],[2,1],[3,1]], O: [[1,0],[2,0],[1,1],[2,1]],
    T: [[1,0],[0,1],[1,1],[2,1]], S: [[1,0],[2,0],[0,1],[1,1]],
    Z: [[0,0],[1,0],[1,1],[2,1]], J: [[0,0],[0,1],[1,1],[2,1]],
    L: [[2,0],[0,1],[1,1],[2,1]]
  };
  const SHAPES = {};
  TYPES.forEach(type => {
    const center = type === 'I' ? 1.5 : 1;
    SHAPES[type] = [SPAWN[type]];
    for (let r = 1; r < 4; r++) {
      SHAPES[type].push(type === 'O' ? SPAWN.O : SHAPES[type][r - 1].map(([x,y]) => [center - (y-center), center + (x-center)]));
    }
  });

  // SRS offsets use positive y upwards; the board uses positive y downwards.
  const JLSTZ_KICKS = {
    '0>1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
    '1>0': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
    '1>2': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
    '2>1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
    '2>3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
    '3>2': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
    '3>0': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
    '0>3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]]
  };
  const I_KICKS = {
    '0>1': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
    '1>0': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    '1>2': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
    '2>1': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
    '2>3': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    '3>2': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
    '3>0': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
    '0>3': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]]
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const emptyBoard = () => Array.from({length: ROWS}, () => Array(COLS).fill(null));
  const isType = value => TYPES.includes(value);
  const finite = (value, lo, hi) => typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;
  const integer = (value, lo, hi) => Number.isInteger(value) && finite(value, lo, hi);

  function normalizeSeed(seed) {
    if (typeof seed === 'string') {
      let hash = 2166136261;
      for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
      return hash >>> 0;
    }
    return Number.isFinite(seed) ? (seed >>> 0) : ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
  }

  function normalizeConfig(input) {
    const config = input || {};
    const number = (name, fallback, lo, hi) => finite(Number(config[name]), lo, hi) ? Number(config[name]) : fallback;
    return {
      mode: MODES.includes(config.mode) ? config.mode : 'marathon',
      startLevel: Math.round(number('startLevel', 1, 1, 20)),
      lockDelay: Math.round(number('lockDelay', 500, 100, 1000)),
      seed: normalizeSeed(config.seed)
    };
  }

  function getCells(piece) {
    if (!piece || !SHAPES[piece.type]) return [];
    return SHAPES[piece.type][piece.rotation || 0].map(([x,y]) => ({x: piece.x+x, y: piece.y+y}));
  }

  function collides(board, piece) {
    return getCells(piece).some(({x,y}) => x < 0 || x >= COLS || y >= ROWS || y < 0 || board[y][x] !== null);
  }

  function ghostY(input) {
    const state = input && input.state ? input.state : input;
    if (!state || !state.active) return null;
    const piece = {...state.active};
    while (!collides(state.board, {...piece, y: piece.y+1})) piece.y++;
    return piece.y;
  }

  function gravityMs(level, mode) {
    if (mode === 'zen' || mode === 'training') return Infinity;
    if (mode === 'classic') {
      const frames = [48,43,38,33,28,23,18,13,8,6,5,5,5,4,4,4,3,3,3,2];
      return (frames[Math.min(Math.max(level-1, 0), 19)] || 1) * 1000/60;
    }
    return Math.max(1000/1200, Math.pow(Math.max(0.05, 0.8-(level-1)*0.007), level-1)*1000);
  }

  class Game {
    constructor(config) {
      this.config = normalizeConfig(config);
      this.events = [];
      this._undoHistory = [];
      this._turnStart = null;
      this.state = {
        version: VERSION, config: clone(this.config), mode: this.config.mode,
        status: 'ready', board: emptyBoard(), active: null,
        queue: [], bag: [], rng: this.config.seed,
        holdType: null, canHold: true,
        score: 0, lines: 0, level: this.config.startLevel,
        combo: -1, b2b: false, b2bCount: 0,
        elapsedMs: 0, pieces: 0, tetrises: 0, tspins: 0,
        fallMs: 0, lockMs: 0, lockResets: 0,
        lastAction: null, lastKick: -1, lastClear: null,
        endReason: null, undoCount: 0
      };
      this._fillQueue();
    }

    _emit(type, data) { this.events.push({type, ...(data || {})}); }
    drainEvents() { const events = this.events; this.events = []; return events; }
    _random() {
      // Mulberry32 keeps an explicit, serializable unsigned state, including seed 0.
      let t = this.state.rng = (this.state.rng + 0x6D2B79F5) >>> 0;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    _nextType() {
      if (this.state.mode === 'classic') return TYPES[Math.floor(this._random()*7)];
      if (!this.state.bag.length) {
        this.state.bag = TYPES.slice();
        for (let i = 6; i > 0; i--) {
          const j = Math.floor(this._random()*(i+1));
          [this.state.bag[i], this.state.bag[j]] = [this.state.bag[j], this.state.bag[i]];
        }
      }
      return this.state.bag.pop();
    }
    _fillQueue() { while (this.state.queue.length < 6) this.state.queue.push(this._nextType()); }
    _running() { return this.state.status === 'running' && this.state.active !== null; }
    _grounded() { return this.state.active && collides(this.state.board, {...this.state.active, y: this.state.active.y+1}); }

    start() {
      if (this.state.status !== 'ready') return false;
      this.state.status = 'running';
      this._spawn();
      this._emit('start');
      return true;
    }
    restart(config) {
      const fresh = new Game(config || this.config);
      this.config = fresh.config;
      this.state = fresh.state;
      this.events = [];
      this._undoHistory = [];
      this._turnStart = null;
      this.start();
      return this;
    }
    pause() {
      if (this.state.status !== 'running') return false;
      this.state.status = 'paused'; this._emit('pause'); return true;
    }
    resume() {
      if (this.state.status !== 'paused') return false;
      this.state.status = 'running'; this._emit('resume'); return true;
    }
    togglePause() { return this.state.status === 'paused' ? this.resume() : this.pause(); }

    // A hold exchanges the active piece within the same turn. Its checkpoint
    // therefore remains the original spawn, including the pre-hold queue/RNG.
    _spawn(type, checkpoint = true) {
      const state = this.state;
      state.active = {type: type || state.queue.shift(), x: 3, y: HIDDEN_ROWS-1, rotation: 0};
      this._fillQueue();
      state.fallMs = 0; state.lockMs = 0; state.lockResets = 0;
      state.lastAction = null; state.lastKick = -1;
      if (collides(state.board, state.active)) this._finish('over', 'blockout');
      else {
        if (checkpoint) this._turnStart = this._captureTurn();
        this._emit('spawn', {piece: state.active.type});
      }
    }

    _captureTurn() {
      const snapshot = clone(this.state);
      snapshot.status = 'running'; snapshot.endReason = null;
      // Time is never rewound. Keeping it out of checkpoints also avoids
      // frame-rate-dependent floating point differences in saved history.
      snapshot.elapsedMs = 0;
      snapshot.fallMs = 0; snapshot.lockMs = 0; snapshot.lockResets = 0;
      return snapshot;
    }

    canUndo() {
      const state = this.state;
      return this._undoHistory.length > 0 && state.status !== 'ready' &&
        !(state.mode === 'ultra' && (state.elapsedMs >= 120000 || state.endReason === 'time'));
    }

    undo() {
      if (!this.canUndo()) return false;
      const elapsedMs = this.state.elapsedMs, undoCount = this.state.undoCount + 1;
      const status = this.state.status === 'running' ? 'running' : 'paused';
      const checkpoint = this._undoHistory.pop();
      this.state = clone(checkpoint);
      this.state.elapsedMs = elapsedMs; this.state.undoCount = undoCount;
      this.state.status = status; this.state.endReason = null;
      this._turnStart = this._captureTurn();
      // Discard any undrained effects for the placement that was just undone.
      this.events = [];
      this._emit('undo', {undoCount});
      return true;
    }

    _resetLock(wasGrounded) {
      if (wasGrounded && this.state.lockResets < 15) {
        this.state.lockMs = 0;
        this.state.lockResets++;
      }
    }

    move(dx) {
      if (!this._running() || (dx !== -1 && dx !== 1)) return false;
      const state = this.state, wasGrounded = this._grounded();
      const candidate = {...state.active, x: state.active.x+dx};
      if (collides(state.board, candidate)) return false;
      state.active = candidate; state.lastAction = 'move'; state.lastKick = -1;
      this._resetLock(wasGrounded);
      this._emit('move', {dx});
      return true;
    }

    rotate(direction) {
      if (!this._running()) return false;
      const dir = direction === undefined ? 1 : direction;
      if (dir === 2) {
        // 180 is two ordinary SRS turns; there is no invented 180 kick table.
        const before = clone(this.state), eventCount = this.events.length;
        if (this.rotate(1) && this.rotate(1)) return true;
        this.state = before; this.events.length = eventCount; return false;
      }
      if (dir !== -1 && dir !== 1) return false;
      const state = this.state, original = state.active;
      const target = (original.rotation+dir+4)%4;
      const kicks = state.mode === 'classic' || original.type === 'O' ? [[0,0]] :
        (original.type === 'I' ? I_KICKS : JLSTZ_KICKS)[original.rotation+'>'+target];
      const wasGrounded = this._grounded();
      for (let i = 0; i < kicks.length; i++) {
        const [x,y] = kicks[i];
        const candidate = {...original, rotation: target, x: original.x+x, y: original.y-y};
        if (!collides(state.board, candidate)) {
          state.active = candidate; state.lastAction = 'rotate'; state.lastKick = i;
          this._resetLock(wasGrounded);
          this._emit('rotate', {direction: dir, kick: i});
          return true;
        }
      }
      return false;
    }

    softDrop() {
      if (!this._running()) return false;
      const state = this.state, candidate = {...state.active, y: state.active.y+1};
      if (collides(state.board, candidate)) return false;
      state.active = candidate; state.score++; state.fallMs = 0;
      state.lastAction = 'drop'; state.lastKick = -1;
      this._emit('softdrop');
      return true;
    }

    hardDrop() {
      if (!this._running()) return false;
      const state = this.state, landing = ghostY(state), distance = landing-state.active.y;
      state.active.y = landing;
      state.score += distance*2;
      if (distance > 0) { state.lastAction = 'drop'; state.lastKick = -1; }
      this._emit('harddrop', {distance});
      this._lock();
      return distance;
    }

    hold() {
      if (!this._running() || !this.state.canHold || this.state.mode === 'classic') return false;
      const state = this.state, previous = state.holdType;
      state.holdType = state.active.type;
      state.canHold = false;
      this._spawn(previous, false);
      this._emit('hold', {piece: state.holdType});
      return true;
    }

    tick(milliseconds) {
      if (!this._running() || !finite(milliseconds, 0, 86400000) || milliseconds === 0) return;
      const state = this.state;
      // Practice modes have no automatic falling or locking, even while a soft-dropped
      // piece rests on a surface. Keep its clock separate from that event loop.
      if (state.mode === 'zen' || state.mode === 'training') {
        state.elapsedMs += milliseconds;
        return;
      }
      let remaining = state.mode === 'ultra' ? Math.min(milliseconds, Math.max(0, 120000-state.elapsedMs)) : milliseconds;
      // Event-based stepping makes a saved game independent of animation frame rate.
      while (remaining > 0 && this._running()) {
        const grounded = this._grounded();
        const gravity = gravityMs(state.level, state.mode);
        const untilFall = grounded ? Infinity : Math.max(0, gravity-state.fallMs);
        const untilLock = grounded ? Math.max(0, this.config.lockDelay-state.lockMs) : Infinity;
        const step = Math.min(remaining, untilFall, untilLock);
        state.elapsedMs += step;
        if (grounded) state.lockMs += step;
        else if (Number.isFinite(gravity)) state.fallMs += step;
        remaining -= step;
        if (untilLock <= step) {
          this._lock();
        } else if (untilFall <= step) {
          state.fallMs = Math.max(0, state.fallMs-gravity);
          state.active.y++;
          // Natural falling does not invalidate a successful T-spin rotation.
          this._emit('fall');
        } else break;
      }
      if (state.mode === 'ultra' && state.elapsedMs >= 120000 && state.status === 'running') this._finish('won', 'time');
    }

    _tSpin() {
      const state = this.state, piece = state.active;
      if (piece.type !== 'T' || state.lastAction !== 'rotate' || state.mode === 'classic') return null;
      const x = piece.x+1, y = piece.y+1;
      const occupied = (xx,yy) => xx < 0 || xx >= COLS || yy < 0 || yy >= ROWS || state.board[yy][xx] !== null;
      const corners = [occupied(x-1,y-1), occupied(x+1,y-1), occupied(x+1,y+1), occupied(x-1,y+1)];
      if (corners.filter(Boolean).length < 3) return null;
      const fronts = [[0,1],[1,2],[2,3],[3,0]][piece.rotation];
      return (corners[fronts[0]] && corners[fronts[1]]) || state.lastKick === 4 ? 'full' : 'mini';
    }

    _lock() {
      if (!this._running()) return;
      if (this._turnStart) {
        this._undoHistory.push(clone(this._turnStart));
        if (this._undoHistory.length > MAX_UNDOS) this._undoHistory.shift();
      }
      const state = this.state, piece = state.active, cells = getCells(piece), spin = this._tSpin();
      cells.forEach(({x,y}) => { state.board[y][x] = piece.type; });
      const cleared = [];
      for (let y = 0; y < ROWS; y++) if (state.board[y].every(Boolean)) cleared.push(y);
      const count = cleared.length;
      if (count) {
        state.board = state.board.filter(row => !row.every(Boolean));
        while (state.board.length < ROWS) state.board.unshift(Array(COLS).fill(null));
      }
      const perfect = count > 0 && state.board.every(row => row.every(cell => cell === null));
      const difficult = count === 4 || (spin && count > 0);
      const previousB2b = state.b2b;
      let base = 0, bonus = 0;
      if (state.mode === 'classic') {
        base = [0,40,100,300,1200][count]*state.level;
        state.combo = count ? state.combo+1 : -1;
      } else {
        base = (spin === 'full' ? [400,800,1200,1600][count] : spin === 'mini' ? [100,200,400][count] : [0,100,300,500,800][count]) * state.level;
        if (difficult && previousB2b) base = Math.floor(base*1.5);
        state.combo = count ? state.combo+1 : -1;
        if (state.combo > 0) bonus += 50*state.combo*state.level;
        if (perfect) bonus += (count === 4 && previousB2b ? 3200 : [0,800,1200,1800,2000][count])*state.level;
      }
      if (count) {
        state.b2b = Boolean(difficult);
        state.b2bCount = difficult ? (previousB2b ? state.b2bCount+1 : 1) : 0;
      }
      state.score += base+bonus;
      state.lines += count;
      state.pieces++;
      if (count === 4) state.tetrises++;
      if (spin) state.tspins++;
      const previousLevel = state.level;
      state.level = Math.min(99, this.config.startLevel+Math.floor(state.lines/10));
      state.lastClear = {lines: count, spin, perfect, combo: state.combo, b2b: Boolean(difficult && previousB2b), points: base+bonus};
      this._emit('lock', {piece: piece.type, cells, ...state.lastClear});
      if (count || spin) this._emit('clear', {...state.lastClear, rows: cleared});
      if (state.level !== previousLevel) this._emit('level', {level: state.level});
      state.canHold = true;
      if (state.mode === 'sprint' && state.lines >= 40) this._finish('won', 'lines');
      else if (!count && cells.every(({y}) => y < HIDDEN_ROWS)) this._finish('over', 'lockout');
      else this._spawn();
    }

    _finish(status, reason) {
      this.state.status = status; this.state.endReason = reason;
      this.state.active = null;
      this._emit(status === 'won' ? 'win' : 'gameover', {reason});
    }

    serialize() {
      return {...clone(this.state), undoHistory: clone(this._undoHistory), turnStart: clone(this._turnStart)};
    }

    static restore(snapshot) {
      const fail = () => { throw new Error('存档损坏或版本不受支持'); };
      if (typeof snapshot === 'string' && snapshot.length > 262144) fail();
      const data = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
      const keys = ['version','config','mode','status','board','active','queue','bag','rng','holdType','canHold','score','lines','level','combo','b2b','b2bCount','elapsedMs','pieces','tetrises','tspins','fallMs','lockMs','lockResets','lastAction','lastKick','lastClear','endReason','undoCount'];
      const onlyKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
      const validateState = (value, checkpoint = false) => {
        if (!onlyKeys(value, checkpoint ? keys : [...keys,'undoHistory','turnStart']) || value.version !== VERSION || !onlyKeys(value.config,['mode','startLevel','lockDelay','seed']) || !MODES.includes(value.mode) || value.config.mode !== value.mode) fail();
        if (!integer(value.config.startLevel,1,20) || !integer(value.config.lockDelay,100,1000) || !integer(value.config.seed,0,0xffffffff)) fail();
        if (!Array.isArray(value.board) || value.board.length !== ROWS || Array.from(value.board).some(row => !Array.isArray(row) || row.length !== COLS || Array.from(row).some(cell => cell !== null && !isType(cell)))) fail();
        if (value.board.some(row => row.every(Boolean))) fail();
        if (!Array.isArray(value.queue) || value.queue.length !== 6 || !Array.from(value.queue).every(isType)) fail();
        if (!Array.isArray(value.bag) || value.bag.length > 7 || !Array.from(value.bag).every(isType) || new Set(value.bag).size !== value.bag.length || !integer(value.rng,0,0xffffffff)) fail();
        if (!['ready','running','paused','over','won'].includes(value.status) || (value.holdType !== null && !isType(value.holdType)) || typeof value.canHold !== 'boolean' || typeof value.b2b !== 'boolean') fail();
        for (const key of ['score','lines','pieces','tetrises','tspins','b2bCount']) if (!integer(value[key],0,Number.MAX_SAFE_INTEGER)) fail();
        if (value.undoCount !== undefined && !integer(value.undoCount,0,Number.MAX_SAFE_INTEGER)) fail();
        if (!integer(value.level,1,99) || value.level !== Math.min(99,value.config.startLevel+Math.floor(value.lines/10)) || !integer(value.combo,-1,Number.MAX_SAFE_INTEGER) || !integer(value.lockResets,0,15)) fail();
        for (const key of ['elapsedMs','fallMs','lockMs']) if (!finite(value[key],0,Number.MAX_SAFE_INTEGER)) fail();
        if (!['move','rotate','drop',null].includes(value.lastAction) || !integer(value.lastKick,-1,4) || ![null,'blockout','lockout','lines','time'].includes(value.endReason)) fail();
        if (value.lastClear !== null && (!onlyKeys(value.lastClear,['lines','spin','perfect','combo','b2b','points']) || !integer(value.lastClear.lines,0,4) || ![null,'mini','full'].includes(value.lastClear.spin) || !integer(value.lastClear.points,0,Number.MAX_SAFE_INTEGER) || !integer(value.lastClear.combo,-1,Number.MAX_SAFE_INTEGER) || typeof value.lastClear.perfect !== 'boolean' || typeof value.lastClear.b2b !== 'boolean')) fail();
        if (value.active !== null) {
          const p = value.active;
          if (!onlyKeys(p,['type','x','y','rotation']) || !isType(p.type) || !integer(p.x,-3,9) || !integer(p.y,-3,23) || !integer(p.rotation,0,3) || collides(value.board,p)) fail();
        }
        if ((['running','paused'].includes(value.status)) !== Boolean(value.active)) fail();
        if (value.mode === 'ultra' && value.elapsedMs > 120000) fail();
        if (checkpoint && (value.status !== 'running' || value.endReason !== null || Object.keys(data.config).some(key => value.config[key] !== data.config[key]))) fail();
      };
      validateState(data);
      if (data.undoHistory !== undefined && (!Array.isArray(data.undoHistory) || data.undoHistory.length > MAX_UNDOS)) fail();
      const history = data.undoHistory || [];
      for (const checkpoint of history) validateState(checkpoint, true);
      if (data.turnStart !== undefined && data.turnStart !== null) validateState(data.turnStart, true);
      if (data.turnStart === null && data.active !== null) fail();
      const copyState = value => Object.fromEntries(keys.map(key => [key, key === 'undoCount' && value[key] === undefined ? 0 : clone(value[key])]));
      const game = new Game(data.config);
      game.state = copyState(data);
      game._undoHistory = history.map(copyState);
      game._turnStart = data.turnStart ? copyState(data.turnStart) : (game.state.active ? game._captureTurn() : null);
      game.events = [];
      return game;
    }
  }

  return {Game, COLS, ROWS, HIDDEN_ROWS, VERSION, TYPES, MODES, SHAPES, COLORS, getCells, ghostY, gravityMs};
});
