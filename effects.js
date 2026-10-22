/* Short, square-pixel board feedback. No DOM, timers, saved state, or audio.
 * consume engine events once; draw after the board on each live animation frame.
 * Colours are piece colours, paper white, and restrained cyan/gold for clears.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PixelEffects = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_PARTICLES = 180, MAX_EFFECTS = 24, MAX_EVENTS = 128;
  const WHITE = '#f6f8ff', CYAN = '#8be9ed', GOLD = '#ffe493';
  const EDGES = [[0,-1],[0,1],[-1,0],[1,0]];
  const DEFAULT_COLORS = {I:'#41d9ed',O:'#f5cf4b',T:'#ba82fa',S:'#8fdb58',Z:'#f3657c',J:'#668bfa',L:'#f6a24d'};
  const time = value => Number.isFinite(value) ? Math.max(0, value) : 0;
  const dimension = (value, fallback, max) => Number.isInteger(value) && value > 0 && value <= max ? value : fallback;

  class BoardEffects {
    constructor(options = {}) {
      this.cell = dimension(options.cell, 20, 64);
      this.cols = dimension(options.cols, 10, 40);
      this.rows = dimension(options.rows, 20, 80);
      this.hiddenRows = Number.isInteger(options.hiddenRows) && options.hiddenRows >= 0 && options.hiddenRows <= 16 ? options.hiddenRows : 4;
      this.width = this.cols * this.cell; this.height = this.rows * this.cell;
      this.colors = {...DEFAULT_COLORS, ...options.colors};
      this.reducedMotion = !!options.reducedMotion;
      this._effects = []; this._particles = [];
      // Pools are allocated once and bounded even during fast autoplay.
      this._freeEffects = Array.from({length:MAX_EFFECTS}, () => ({cells:Array.from({length:4}, () => ({x:0,y:0})), rows:Array(4).fill(0)}));
      this._freeParticles = Array.from({length:MAX_PARTICLES}, () => ({}));
      this._seed = 0x7417a1; this._shakeAt = 0; this._shakeUntil = 0; this._shakeSize = 0;
    }

    _random() {
      let x = this._seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      this._seed = x >>> 0; return this._seed / 4294967296;
    }

    _prune(now) {
      for (const [active, free] of [[this._effects,this._freeEffects],[this._particles,this._freeParticles]]) {
        for (let i = active.length - 1; i >= 0; i--) if (now >= active[i].end) {
          const expired = active[i], last = active.pop();
          if (i < active.length) active[i] = last;
          free.push(expired);
        }
      }
    }

    _effect(type, now, duration) {
      const effect = this._freeEffects.pop() || this._effects.shift();
      effect.type = type; effect.start = now; effect.end = now + duration;
      effect.count = 0; effect.strength = 1; effect.perfect = false;
      this._effects.push(effect); return effect;
    }

    _particle(x, y, color, now, strength, direction = 0) {
      if (this.reducedMotion || !this._freeParticles.length) return;
      const particle = this._freeParticles.pop(), random = () => this._random();
      particle.x = x; particle.y = y; particle.start = now;
      particle.end = now + 170 + random() * 190;
      particle.vx = (random() - .5) * (105 + strength * 40) + direction * 42;
      particle.vy = -(35 + random() * (85 + strength * 14));
      particle.size = random() < .7 ? 2 : 3;
      particle.color = random() < .34 ? WHITE : color;
      this._particles.push(particle);
    }

    _shake(now, size, duration) {
      if (this.reducedMotion) return;
      if (now >= this._shakeUntil || size >= this._shakeSize) {
        this._shakeAt = now; this._shakeUntil = now + duration; this._shakeSize = size;
      }
    }

    _drop(lock, distance, now) {
      const cells = Array.isArray(lock.cells) ? lock.cells.slice(0,4).filter(cell => cell && Number.isInteger(cell.x) && cell.x >= 0 && cell.x < this.cols && Number.isInteger(cell.y) && cell.y >= 0 && cell.y < this.rows + this.hiddenRows) : [];
      if (!cells.length) return;
      const effect = this._effect('drop', now, this.reducedMotion ? 95 : 175);
      effect.color = this.colors[lock.piece] || CYAN;
      effect.distance = Math.max(0, Math.min(distance, this.rows + this.hiddenRows));
      effect.count = cells.length;
      cells.forEach((cell, i) => {effect.cells[i].x = cell.x; effect.cells[i].y = cell.y - this.hiddenRows;});
      if (!this.reducedMotion) {
        const visible = cells.filter(cell => cell.y >= this.hiddenRows);
        for (const cell of visible) for (let i = 0; i < 3; i++) this._particle((cell.x+.5)*this.cell, (cell.y-this.hiddenRows+1)*this.cell-2, effect.color, now, 1, cell.x < this.cols/2 ? -1 : 1);
        this._shake(now, effect.distance > 3 ? 2 : 1, 85);
      }
    }

    _clear(event, now) {
      if (!Number.isInteger(event.lines) || event.lines < 1 || event.lines > 4 || !Array.isArray(event.rows)) return;
      const rows = [...new Set(event.rows.filter(row => Number.isInteger(row) && row >= this.hiddenRows && row < this.hiddenRows + this.rows))].slice(0, event.lines);
      if (!rows.length) return;
      const strength = event.perfect ? 2 : event.lines === 4 ? 1.7 : event.spin ? 1.45 : 1;
      const effect = this._effect('clear', now, this.reducedMotion ? 110 : 225 + (strength-1)*105);
      effect.count = rows.length; effect.strength = strength; effect.perfect = !!event.perfect;
      effect.color = strength > 1 ? GOLD : CYAN;
      rows.forEach((row, i) => {effect.rows[i] = row - this.hiddenRows;});
      if (!this.reducedMotion) {
        const count = Math.min(76, Math.round(16 + rows.length*9 + (strength-1)*18));
        for (let i = 0; i < count; i++) {
          const x = this._random()*this.width, y = (effect.rows[i%rows.length]+.5)*this.cell;
          this._particle(x,y,effect.color,now,strength,x < this.width/2 ? -1 : 1);
        }
        this._shake(now, strength > 1 ? 2 : 1, 85 + (strength-1)*20);
      }
    }

    consume(events, now) {
      now = time(now); this._prune(now);
      if (!Array.isArray(events)) return;
      const first = Math.max(0, events.length-MAX_EVENTS);
      for (let i = first; i < events.length; i++) {
        const event = events[i];
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'undo' || event.type === 'start') this.clear();
        else if (event.type === 'harddrop') {
          const lock = events[i+1];
          // A lone lock is ordinary gravity. Never infer a drop from a clear.
          if (Number.isInteger(event.distance) && event.distance >= 0 && lock?.type === 'lock') this._drop(lock,event.distance,now);
        } else if (event.type === 'clear') this._clear(event,now);
      }
    }

    _drawDrop(ctx, effect, now) {
      const age = now-effect.start, progress = age/(effect.end-effect.start), cell = this.cell;
      const alpha = 1-progress, reduced = this.reducedMotion;
      if (!reduced && effect.distance > 0 && age < 110) {
        for (let i = 0; i < effect.count; i++) {
          const point = effect.cells[i];
          let top = true;
          for (let j = 0; j < effect.count; j++) if (effect.cells[j].x === point.x && effect.cells[j].y < point.y) top = false;
          if (!top) continue;
          const length = Math.min(effect.distance*cell,cell*4), x = point.x*cell, y = point.y*cell;
          ctx.fillStyle = effect.color; ctx.globalAlpha = .38*(1-age/110);
          ctx.fillRect(x+cell/2-3,y-length,6,length);
          ctx.fillStyle = WHITE; ctx.globalAlpha = .68*(1-age/110);
          ctx.fillRect(x+cell/2-1,y-length,2,length);
          // Two little detached pixels make the tail read as speed, not a ghost.
          ctx.fillRect(x+2,y-Math.min(length,cell*2),2,3);
          ctx.fillRect(x+cell-4,y-Math.min(length,cell*3),2,4);
        }
      }
      ctx.fillStyle = WHITE;
      for (let i = 0; i < effect.count; i++) {
        const point = effect.cells[i], x = point.x*cell, y = point.y*cell;
        ctx.globalAlpha = reduced ? .17*alpha : age < 42 ? .66*(1-age/60) : .08*alpha;
        ctx.fillRect(x+1,y+1,cell-2,cell-2);
        ctx.globalAlpha = (reduced ? .32 : .95)*alpha;
        const thick = !reduced && age < 65 ? 2 : 1;
        for (const [dx,dy] of EDGES) {
          let neighbour = false;
          for (let j = 0; j < effect.count; j++) if (effect.cells[j].x === point.x+dx && effect.cells[j].y === point.y+dy) neighbour = true;
          if (neighbour) continue;
          if (dy) ctx.fillRect(x+1,y+(dy > 0 ? cell-thick : 0),cell-2,thick);
          else ctx.fillRect(x+(dx > 0 ? cell-thick : 0),y+1,thick,cell-2);
        }
      }
    }

    _drawClear(ctx, effect, now) {
      const age = now-effect.start, progress = age/(effect.end-effect.start), fade = 1-progress;
      for (let i = 0; i < effect.count; i++) {
        const y = effect.rows[i]*this.cell;
        if (this.reducedMotion) {
          ctx.fillStyle = WHITE; ctx.globalAlpha = .2*fade;
          ctx.fillRect(0,y+1,this.width,this.cell-2); continue;
        }
        // A short flash then a stepped horizontal sweep; no gradients or blur.
        if (age < 65) {
          ctx.fillStyle = WHITE; ctx.globalAlpha = .68*(1-age/65);
          ctx.fillRect(0,y+1,this.width,this.cell-2);
        }
        ctx.fillStyle = effect.color; ctx.globalAlpha = .38*fade;
        ctx.fillRect(0,y+this.cell/2-1,this.width,2);
        const head = Math.floor((-24+(this.width+48)*Math.min(1,progress/ .85))/2)*2;
        ctx.globalAlpha = .8*fade; ctx.fillRect(head-12,y+3,22,this.cell-6);
        ctx.fillStyle = WHITE; ctx.globalAlpha = fade;
        ctx.fillRect(head+6,y+1,4,this.cell-2);
        ctx.fillRect(head-20,y+this.cell/2-1,6,2);
      }
      if (effect.perfect && !this.reducedMotion && age < 155) {
        ctx.fillStyle = GOLD; ctx.globalAlpha = .72*(1-age/155);
        const size = Math.max(3,12-Math.floor(age/20));
        for (const [x,y,sx,sy] of [[0,0,1,1],[this.width-1,0,-1,1],[0,this.height-1,1,-1],[this.width-1,this.height-1,-1,-1]]) {
          ctx.fillRect(sx > 0 ? x : x-size+1,y,size,2);
          ctx.fillRect(x,sy > 0 ? y : y-size+1,2,size);
        }
      }
    }

    draw(ctx, now) {
      now = time(now); this._prune(now);
      if (!this._effects.length && !this._particles.length) return false;
      ctx.save(); ctx.beginPath(); ctx.rect(0,0,this.width,this.height); ctx.clip();
      for (const effect of this._effects) if (now >= effect.start) {
        if (effect.type === 'drop') this._drawDrop(ctx,effect,now);
        else this._drawClear(ctx,effect,now);
      }
      for (const particle of this._particles) if (now >= particle.start) {
        const age = (now-particle.start)/1000, duration = (particle.end-particle.start)/1000;
        ctx.globalAlpha = Math.min(1,(1-age/duration)*1.5); ctx.fillStyle = particle.color;
        ctx.fillRect(Math.round(particle.x+particle.vx*age),Math.round(particle.y+particle.vy*age+155*age*age),particle.size,particle.size);
      }
      ctx.restore(); return true;
    }

    offset(now) {
      now = time(now);
      if (this.reducedMotion || now < this._shakeAt || now >= this._shakeUntil) return {x:0,y:0};
      const progress = (now-this._shakeAt)/(this._shakeUntil-this._shakeAt);
      const size = Math.max(0,Math.round(this._shakeSize*(1-progress)));
      const step = Math.floor((now-this._shakeAt)/22);
      return {x:step%2 ? size : -size,y:step%3 ? 0 : size};
    }

    setReducedMotion(value) {
      this.reducedMotion = !!value;
      if (this.reducedMotion) {
        while (this._particles.length) this._freeParticles.push(this._particles.pop());
        this._shakeUntil = 0;
        for (const effect of this._effects) {effect.end = Math.min(effect.end,effect.start+110); if (effect.type === 'drop') effect.distance = 0;}
      }
    }

    clear() {
      while (this._effects.length) this._freeEffects.push(this._effects.pop());
      while (this._particles.length) this._freeParticles.push(this._particles.pop());
      this._shakeUntil = 0;
    }

    stats() {return {active:!!(this._effects.length || this._particles.length),effects:this._effects.length,particles:this._particles.length,reducedMotion:this.reducedMotion};}
  }

  return Object.freeze({BoardEffects,MAX_PARTICLES,MAX_EFFECTS,MAX_EVENTS});
});
