'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');
const F = require('../effects.js');

function canvas() {
  const stack = [], rectangles = [], clips = [];
  return {
    rectangles, clips, globalAlpha:1, fillStyle:'#000',
    save() {stack.push({globalAlpha:this.globalAlpha,fillStyle:this.fillStyle});},
    restore() {Object.assign(this,stack.pop());},
    beginPath() {}, rect(...rectangle) {clips.push(rectangle);}, clip() {},
    fillRect(x,y,width,height) {rectangles.push({x,y,width,height,alpha:this.globalAlpha,color:this.fillStyle});}
  };
}
function fresh() {const game = new E.Game({seed:7}); game.start(); game.drainEvents(); return game;}
function lockCells() {return [{x:3,y:22},{x:4,y:22},{x:3,y:23},{x:4,y:23}];}
function drop(distance = 16) {return [{type:'harddrop',distance},{type:'lock',piece:'O',cells:lockCells()}];}
function clear(lines = 1, extra = {}) {return {type:'clear',lines,rows:Array.from({length:lines},(_,index)=>23-index),...extra};}

test('real hard-drop events produce a clipped pixel trail and impact, then expire', () => {
  const game = fresh(), fx = new F.BoardEffects(), ctx = canvas();
  game.hardDrop(); const events = game.drainEvents();
  fx.consume(events,100);
  assert.equal(fx.stats().effects,1); assert.ok(fx.stats().particles > 0);
  assert.equal(fx.draw(ctx,100),true);
  assert.deepEqual(ctx.clips,[[0,0,200,400]]);
  assert.ok(ctx.rectangles.some(rect => rect.width <= 6 && rect.height > 20),'visible speed trail');
  assert.ok(ctx.rectangles.some(rect => rect.color === '#f6f8ff' && rect.width >= 18),'white landing impact');
  assert.equal(ctx.globalAlpha,1,'canvas state is restored');
  assert.equal(fx.draw(ctx,700),false);
  assert.deepEqual(fx.stats(),{active:false,effects:0,particles:0,reducedMotion:false});
  assert.deepEqual(fx.offset(700),{x:0,y:0});
});

test('a zero-distance hard drop has an impact without inventing a falling trail', () => {
  const game = fresh(); game.state.active.y = E.ghostY(game.state); game.hardDrop();
  const events = game.drainEvents(); assert.equal(events[0].distance,0);
  const fx = new F.BoardEffects(), ctx = canvas(); fx.consume(events,0); fx.draw(ctx,0);
  assert.equal(fx.stats().effects,1);
  assert.ok(ctx.rectangles.some(rect => rect.width >= 18));
  assert.ok(ctx.rectangles.every(rect => rect.height <= 20),'no long fake trail from an already grounded piece');
});

test('ordinary gravity locks and unpaired harddrop messages do not masquerade as manual drops', () => {
  const game = fresh(), fx = new F.BoardEffects();
  game.state.active.y = E.ghostY(game.state); game.tick(600);
  const events = game.drainEvents(); assert.ok(events.some(event=>event.type === 'lock'));
  fx.consume(events,0); assert.equal(fx.stats().active,false);
  fx.consume([{type:'harddrop',distance:12},{type:'move'},{type:'lock',piece:'O',cells:lockCells()}],10);
  assert.equal(fx.stats().active,false);
  fx.consume([{type:'harddrop',distance:12}],20);
  fx.consume([{type:'lock',piece:'O',cells:lockCells()}],30);
  assert.equal(fx.stats().active,false,'an unpaired drop cannot attach to a later turn');
});

test('line clears sweep their actual row; a zero-line Spin does not create a clear flash', () => {
  const fx = new F.BoardEffects(), ctx = canvas();
  fx.consume([clear(0,{spin:'full',rows:[]})],0); assert.equal(fx.draw(ctx,0),false);
  fx.consume([clear(1)],10); assert.equal(fx.draw(ctx,10),true);
  assert.ok(ctx.rectangles.some(rect => rect.x === 0 && rect.width === 200 && rect.y === 381),'last visible row flashes');
  assert.ok(ctx.rectangles.filter(rect=>rect.width > 100).every(rect=>rect.y >= 380 && rect.y < 400),'flash stays on the eliminated row');
  const later = canvas(); fx.draw(later,90);
  assert.ok(later.rectangles.some(rect => rect.width === 4 && rect.height === 18 && rect.x > 0),'pixel sweep moves horizontally');
});

test('Tetris, scoring Spin, and perfect clears add controlled emphasis rather than a long obstruction', () => {
  const single = new F.BoardEffects(), quad = new F.BoardEffects(), spin = new F.BoardEffects(), perfect = new F.BoardEffects();
  single.consume([clear(1)],0); quad.consume([clear(4)],0);
  spin.consume([clear(2,{spin:'full'})],0); perfect.consume([clear(4,{perfect:true})],0);
  assert.ok(quad.stats().particles > single.stats().particles);
  assert.ok(spin.stats().particles > single.stats().particles);
  assert.ok(perfect.stats().particles >= quad.stats().particles);
  for (const fx of [single,quad,spin,perfect]) {
    const offset = fx.offset(20);
    assert.ok(Math.abs(offset.x) <= 2 && Math.abs(offset.y) <= 2,'shake stays within two board pixels');
    assert.equal(fx.draw(canvas(),500),false,'all feedback has ended within half a second');
  }
});

test('fast autoplay and oversized event batches cannot grow the effect pools', () => {
  const fx = new F.BoardEffects(), events = [];
  for (let i = 0; i < 1000; i++) events.push(...drop(),clear(4,{perfect:true}));
  fx.consume(events,0);
  assert.ok(fx.stats().effects > 0);
  assert.ok(fx.stats().effects <= F.MAX_EFFECTS);
  assert.ok(fx.stats().particles <= F.MAX_PARTICLES);
  fx.clear();
  for (let i = 0; i < 80; i++) fx.consume([...drop(),clear(4)],i*20);
  assert.ok(fx.stats().effects <= F.MAX_EFFECTS);
  assert.ok(fx.stats().particles <= F.MAX_PARTICLES);
  assert.equal(fx.draw(canvas(),3000),false);
  fx.consume(drop(),3100); assert.ok(fx.stats().particles > 0,'expired pool entries can be reused');
});

test('reduced motion keeps only short low-opacity highlights without particles, trails, or shake', () => {
  const fx = new F.BoardEffects({reducedMotion:true}), ctx = canvas();
  fx.consume([...drop(),clear(4,{perfect:true})],0); fx.draw(ctx,0);
  assert.equal(fx.stats().particles,0);
  assert.deepEqual(fx.offset(0),{x:0,y:0});
  assert.ok(ctx.rectangles.length > 0);
  assert.ok(ctx.rectangles.every(rect=>rect.height <= 20 && rect.alpha <= .32));
  assert.equal(fx.draw(canvas(),120),false);
  fx.setReducedMotion(false); fx.consume(drop(),200); assert.ok(fx.stats().particles > 0);
  fx.setReducedMotion(true); assert.equal(fx.stats().particles,0);
  assert.deepEqual(fx.offset(200),{x:0,y:0});
  assert.equal(fx.draw(canvas(),320),false,'changing preference also shortens existing highlights');
});

test('undo, restart, and explicit clearing release feedback instead of leaking it into another board', () => {
  const fx = new F.BoardEffects();
  for (const event of [{type:'undo'},{type:'start'}]) {
    fx.consume([...drop(),clear(2)],100); assert.ok(fx.stats().active);
    fx.consume([event],120); assert.equal(fx.draw(canvas(),120),false);
    assert.deepEqual(fx.offset(120),{x:0,y:0});
  }
  fx.consume(drop(),200); fx.clear(); fx.clear();
  assert.equal(fx.stats().active,false);
  fx.consume(drop(),300); assert.ok(fx.draw(canvas(),300),'clearing remains safe and reusable');
});
