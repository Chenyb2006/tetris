'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

function fresh(config = {}) {
  const game = new E.Game({seed: 123456, ...config});
  game.start(); game.drainEvents();
  return game;
}
function clearBoard(game) {
  game.state.board = Array.from({length:E.ROWS}, () => Array(E.COLS).fill(null));
}
function active(game, type, x, y, rotation = 0) {
  game.state.active = {type,x,y,rotation};
  game.state.lastAction = null; game.state.lastKick = -1;
  game.state.fallMs = 0; game.state.lockMs = 0; game.state.lockResets = 0;
}
function tetrisWell(game) {
  clearBoard(game);
  for (let y = 20; y < 24; y++) for (let x = 0; x < 9; x++) game.state.board[y][x] = 'J';
  game.state.board[19][0] = 'S'; // Keep this from becoming a perfect clear.
  active(game,'I',7,20,1);
}
function singleWell(game) {
  clearBoard(game);
  for (let x = 0; x < 10; x++) if (x !== 4 && x !== 5) game.state.board[23][x] = 'J';
  active(game,'O',3,22);
}

test('seven-bag contains every piece once and equal seeds replay exactly', () => {
  const a = fresh(), b = fresh(), pieces = [];
  for (let i = 0; i < 28; i++) {
    pieces.push(a.state.active.type);
    assert.equal(a.state.active.type,b.state.active.type);
    a.hardDrop(); b.hardDrop(); clearBoard(a); clearBoard(b);
  }
  for (let i = 0; i < 28; i += 7) assert.deepEqual(pieces.slice(i,i+7).sort(),E.TYPES.slice().sort());
  assert.deepEqual(a.serialize(), b.serialize());
});

test('spawning is immediately visible; collisions keep every piece in the field', () => {
  const g = fresh();
  assert.ok(E.getCells(g.state.active).some(cell => cell.y >= E.HIDDEN_ROWS));
  for (let i=0;i<15;i++) g.move(-1);
  assert.ok(E.getCells(g.state.active).every(cell=>cell.x>=0));
  for (let i=0;i<20;i++) g.move(1);
  assert.ok(E.getCells(g.state.active).every(cell=>cell.x<10));
});

test('SRS uses distinct JLSTZ and I wall kicks and upward floor kicks', () => {
  const g = fresh();
  active(g,'T',-1,18,1);
  assert.equal(g.rotate(-1),true);
  assert.equal(g.state.active.x,0); assert.equal(g.state.lastKick,1);
  active(g,'I',-2,18,1);
  assert.equal(g.rotate(1),true);
  assert.equal(g.state.active.x,0); assert.equal(g.state.lastKick,2);
  active(g,'I',3,22,0);
  assert.equal(g.rotate(1),true);
  assert.deepEqual(g.state.active,{type:'I',x:4,y:20,rotation:1});
  assert.equal(g.state.lastKick,4);
  active(g,'T',3,22,0);
  assert.equal(g.rotate(1),true);
  assert.deepEqual(g.state.active,{type:'T',x:2,y:21,rotation:1});
  assert.equal(g.state.lastKick,2);
});

test('failed rotations do not mutate the active piece or lock timer', () => {
  const g = fresh();
  active(g,'T',3,10,0);
  for (let y=8;y<16;y++) for (let x=0;x<10;x++) g.state.board[y][x]='Z';
  E.getCells(g.state.active).forEach(({x,y})=>g.state.board[y][x]=null);
  const before = g.serialize();
  assert.equal(g.rotate(1),false);
  assert.deepEqual(g.serialize(),before);
});

test('hold is usable once per lock and swapping resets position and rotation', () => {
  const g = fresh(), first = g.state.active.type, next = g.state.queue[0];
  assert.equal(g.hold(),true);
  assert.equal(g.state.holdType,first); assert.equal(g.state.active.type,next);
  assert.equal(g.hold(),false);
  g.hardDrop();
  assert.equal(g.state.canHold,true);
  g.move(-1); g.rotate(1);
  assert.equal(g.hold(),true);
  assert.deepEqual(g.state.active,{type:first,x:3,y:3,rotation:0});
});

test('soft and hard drop score distance and hard drop locks immediately', () => {
  const g = fresh(); active(g,'I',3,3);
  assert.equal(g.softDrop(),true); assert.equal(g.state.score,1);
  const landing = E.ghostY(g), distance = landing-g.state.active.y;
  assert.equal(g.hardDrop(),distance);
  assert.equal(g.state.score,1+distance*2);
  assert.equal(g.state.pieces,1);
  assert.equal(g.state.board[23].filter(Boolean).length,4);
});

test('line clears preserve board size, award combos, and level every ten lines', () => {
  const g = fresh(); singleWell(g); g.hardDrop();
  assert.equal(g.state.lines,1); assert.equal(g.state.score,100); assert.equal(g.state.combo,0);
  singleWell(g); g.hardDrop();
  assert.equal(g.state.score,250); assert.equal(g.state.combo,1);
  assert.equal(g.state.board.length,24);
  g.state.lines=9; singleWell(g); g.hardDrop();
  assert.equal(g.state.level,2);
  assert.ok(E.gravityMs(2)<E.gravityMs(1));
  assert.ok(E.gravityMs(20)<E.gravityMs(15));
  assert.equal(E.gravityMs(99),1000/1200);
});

test('back-to-back tetrises get a 1.5 multiplier and survive empty placements', () => {
  const g = fresh(); tetrisWell(g); g.hardDrop();
  assert.equal(g.state.score,800); assert.equal(g.state.b2b,true);
  clearBoard(g); active(g,'O',0,22); g.hardDrop();
  assert.equal(g.state.b2b,true); assert.equal(g.state.combo,-1);
  tetrisWell(g); g.hardDrop();
  assert.equal(g.state.lastClear.points,1200); assert.equal(g.state.b2bCount,2);
  singleWell(g); g.hardDrop();
  assert.equal(g.state.b2b,false);
});

test('perfect clear adds its own bonus', () => {
  const g = fresh(); clearBoard(g);
  for (let y=22;y<24;y++) for (let x=0;x<10;x++) if(x!==4&&x!==5) g.state.board[y][x]='L';
  active(g,'O',3,22); g.hardDrop();
  assert.equal(g.state.lastClear.perfect,true);
  assert.equal(g.state.lines,2); assert.equal(g.state.score,1500);
  assert.ok(g.state.board.every(row=>row.every(cell=>cell===null)));
});

test('T-spin recognizes three corners, front corners, mini, and the fifth-kick upgrade', () => {
  const g = fresh();
  function setup(corners, kick=0) {
    clearBoard(g); active(g,'T',3,21,0);
    corners.forEach(([x,y])=>g.state.board[y][x]='J');
    g.state.lastAction='rotate'; g.state.lastKick=kick;
  }
  setup([[3,21],[5,21],[3,23]]);
  assert.equal(g._tSpin(),'full');
  setup([[3,21],[3,23],[5,23]]);
  assert.equal(g._tSpin(),'mini');
  g.state.lastKick=4;
  assert.equal(g._tSpin(),'full');
  g.state.lastAction='move';
  assert.equal(g._tSpin(),null);
  setup([[3,21],[5,21],[3,23]]);
  g.hardDrop();
  assert.equal(g.state.lastClear.spin,'full'); assert.equal(g.state.lastClear.points,400);
});

test('ground lock waits for the chosen delay and successful grounded actions cap at 15 resets', () => {
  const g=fresh({lockDelay:500}); active(g,'O',3,22);
  g.tick(499); assert.equal(g.state.pieces,0);
  for(let i=0;i<15;i++) { assert.equal(g.move(i%2?-1:1),true); g.tick(20); }
  assert.equal(g.state.lockResets,15);
  const before=g.state.lockMs;
  g.move(-1); assert.equal(g.state.lockMs,before);
  g.tick(500-before); assert.equal(g.state.pieces,1);
});

test('tick is frame-rate independent and pause excludes time and controls', () => {
  const a=fresh({startLevel:7}), b=fresh({startLevel:7});
  a.tick(18000);
  for(let i=0;i<1800;i++) b.tick(10);
  const aState=a.serialize(), bState=b.serialize();
  for (const key of ['elapsedMs','fallMs','lockMs']) {
    assert.ok(Math.abs(aState[key]-bState[key])<1e-7);
    bState[key]=aState[key];
  }
  assert.deepEqual(aState,bState);
  const g=fresh(); g.pause(); const before=g.serialize();
  g.tick(10000); assert.equal(g.move(1),false); assert.equal(g.hardDrop(),false);
  assert.deepEqual(g.serialize(),before);
  g.resume();g.tick(1000);assert.equal(g.state.elapsedMs,1000);
});

test('sprint finishes at 40 lines; ultra ends at exactly 120 seconds; zen never falls', () => {
  const sprint=fresh({mode:'sprint'}); sprint.state.lines=36;sprint.state.level=4;
  tetrisWell(sprint);sprint.hardDrop();
  assert.equal(sprint.state.status,'won');assert.equal(sprint.state.endReason,'lines');
  const ultra=fresh({mode:'ultra'});ultra.state.elapsedMs=119900;ultra.tick(900);
  assert.equal(ultra.state.status,'won');assert.equal(ultra.state.elapsedMs,120000);
  const zen=fresh({mode:'zen'}), original={...zen.state.active};zen.tick(100000);
  assert.deepEqual(zen.state.active,original);assert.equal(zen.state.pieces,0);
});

test('zen stays silent and unlocked while holding soft drop against a surface', () => {
  const g=fresh({mode:'zen'});clearBoard(g);
  // Stop on a ledge rather than the floor, then slide off and drop again.
  g.state.board[20][4]='J';g.state.board[20][5]='J';
  active(g,'O',3,3);
  let drops=0;
  while(g.softDrop())drops++;
  assert.equal(drops,15);
  assert.equal(g.drainEvents().filter(event=>event.type==='softdrop').length,drops);
  const resting={...g.state.active},score=g.state.score;
  for(let i=0;i<9000;i++) {
    assert.equal(g.softDrop(),false);
    g.tick(35);
  }
  assert.deepEqual(g.state.active,resting);
  assert.equal(g.state.score,score);
  assert.equal(g.state.status,'running');assert.equal(g.state.pieces,0);
  assert.equal(g.state.elapsedMs,315000);
  assert.equal(g.state.fallMs,0);assert.equal(g.state.lockMs,0);
  assert.deepEqual(g.drainEvents(),[]);
  assert.equal(g.move(1),true);assert.equal(g.move(1),true);g.drainEvents();
  assert.equal(g.softDrop(),true);
  assert.deepEqual(g.drainEvents().map(event=>event.type),['softdrop']);
  g.hardDrop();
  assert.equal(g.state.pieces,1);
  assert.ok(g.drainEvents().some(event=>event.type==='lock'));
});

test('training uses modern rules while the clock never causes falling or locking', () => {
  const g=fresh({mode:'training',startLevel:20,lockDelay:100}), initial={...g.state.active};
  assert.ok(E.MODES.includes('training'));
  assert.equal(E.gravityMs(20,'training'),Infinity);
  g.tick(100000);
  assert.deepEqual(g.state.active,initial);assert.equal(g.state.elapsedMs,100000);
  assert.equal(g.state.pieces,0);assert.equal(g.state.status,'running');
  assert.equal(g.hold(),true,'training retains modern hold');
  active(g,'T',-1,18,1);
  assert.equal(g.rotate(-1),true,'training retains SRS wall kicks');
  assert.equal(g.state.active.x,0);assert.equal(g.state.lastKick,1);
  clearBoard(g);active(g,'O',3,3);g.drainEvents();
  while(g.softDrop()) {}
  g.drainEvents();const resting={...g.state.active},score=g.state.score;
  for(let i=0;i<90;i++){assert.equal(g.softDrop(),false);g.tick(1000);}
  assert.deepEqual(g.state.active,resting);assert.equal(g.state.score,score);
  assert.equal(g.state.pieces,0);assert.equal(g.state.lockMs,0);
  assert.equal(g.state.fallMs,0);assert.deepEqual(g.drainEvents(),[]);
  g.hardDrop();assert.equal(g.state.pieces,1);
  assert.ok(g.drainEvents().some(event=>event.type==='lock'));
});

test('training scenes restore their own turn and retain modern scoring without changing old modes', () => {
  const setup=fresh({mode:'training'});tetrisWell(setup);
  const snapshot=setup.serialize();
  delete snapshot.turnStart;delete snapshot.undoHistory;
  const g=E.Game.restore(snapshot),before=structuredClone(g.state);
  g.tick(5000);g.hardDrop();
  assert.equal(g.state.lastClear.lines,4);assert.equal(g.state.lastClear.points,800);
  assert.equal(g.state.mode,'training');assert.equal(g.undo(),true);
  assertTurnRestored(g,before,5000,1);
  const restored=E.Game.restore(JSON.stringify(g.serialize()));
  assert.deepEqual(restored.serialize(),g.serialize());
  for(const mode of ['marathon','sprint','ultra','zen','classic']) {
    const old=fresh({mode});const legacy=old.serialize();
    delete legacy.undoHistory;delete legacy.turnStart;delete legacy.undoCount;
    assert.equal(E.Game.restore(legacy).state.mode,mode);
  }
});

test('classic disables hold and kicks and uses classic line scoring', () => {
  const g=fresh({mode:'classic'});assert.equal(g.hold(),false);
  active(g,'T',-1,18,1);assert.equal(g.rotate(-1),false);
  singleWell(g);g.hardDrop();assert.equal(g.state.score,40);
  assert.ok(g.state.queue.length===6);
});

test('spawn blockout and full hidden-row lockout end the game', () => {
  const blocked=fresh(); clearBoard(blocked);
  blocked.state.board[3].fill('Z');blocked.state.board[4].fill('Z');
  blocked._spawn();assert.equal(blocked.state.status,'over');assert.equal(blocked.state.endReason,'blockout');
  const hidden=fresh();clearBoard(hidden);active(hidden,'O',3,1);
  hidden.state.board[3][4]='J';hidden.state.board[3][5]='J';
  hidden.hardDrop();assert.equal(hidden.state.status,'over');assert.equal(hidden.state.endReason,'lockout');
});

test('save and restore continue every counter, timer, hold, and random sequence', () => {
  const g=fresh({seed:'same daily puzzle',startLevel:3});
  g.move(-1);g.rotate(1);g.tick(178);g.hold();g.softDrop();g.pause();
  const saved=g.serialize(), restored=E.Game.restore(JSON.stringify(saved));
  assert.deepEqual(restored.serialize(),saved);
  assert.notEqual(restored.state.board,g.state.board);
  restored.resume();g.resume();
  for(let i=0;i<14;i++) {
    g.hardDrop();restored.hardDrop();clearBoard(g);clearBoard(restored);
    g.tick(137);restored.tick(137);
    assert.deepEqual(restored.serialize(),g.serialize());
  }
});

test('corrupt, unsupported, out-of-bounds, and overlapping saves are rejected', () => {
  const original=fresh().serialize();
  const mutations=[
    s=>{s.version=99;},s=>{s.board[0][0]='evil';},s=>{s.board.pop();},
    s=>{s.queue=[];},s=>{s.rng=-1;},s=>{s.lockResets=16;},s=>{s.score=-1;},
    s=>{s.active.x=-9;},s=>{s.config.lockDelay=0;},s=>{s.level=99;},
    s=>{s.board[23].fill('I');},
    s=>{s.status='running';s.active=null;},s=>{const c=E.getCells(s.active)[0];s.board[c.y][c.x]='I';}
  ];
  for(const mutate of mutations) {const s=structuredClone(original);mutate(s);assert.throws(()=>E.Game.restore(s));}
  assert.throws(()=>E.Game.restore('{broken'));
});

test('deterministic input sequences keep legal cells and produce restorable snapshots', () => {
  for (const mode of E.MODES) {
    const g=fresh({mode,startLevel:12});
    let seed=41;
    for (let i=0;i<600&&g.state.status==='running';i++) {
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      switch(seed%8) {
        case 0:g.move(-1);break;case 1:g.move(1);break;
        case 2:g.rotate(1);break;case 3:g.rotate(-1);break;
        case 4:g.softDrop();break;case 5:g.hardDrop();break;
        case 6:g.hold();break;case 7:g.tick(seed%250);break;
      }
      assert.deepEqual(E.Game.restore(g.serialize()).serialize(),g.serialize());
      assert.ok(g.state.board.length===24&&g.state.board.every(row=>row.length===10));
    }
  }
});

function assertTurnRestored(game, expected, elapsedMs, undoCount, status = 'running') {
  assert.deepEqual(game.state, {...expected, elapsedMs, undoCount, status, endReason:null, fallMs:0, lockMs:0, lockResets:0});
}

// Fixtures restored as legacy saves deliberately start their first undoable
// turn at the supplied position, just as an existing pre-undo save does.
function legacyCheckpoint(game) {
  const saved=game.serialize();
  delete saved.undoHistory;delete saved.turnStart;delete saved.undoCount;
  return E.Game.restore(saved);
}

test('undo restores the complete turn before movement, drops, and an empty hold', () => {
  const g=fresh(), expected=structuredClone(g.state);
  assert.equal(g.canUndo(),false);assert.equal(g.undo(),false);
  g.move(-1);g.softDrop();g.tick(173);g.hold();g.rotate(1);g.hardDrop();
  assert.notEqual(g.state.rng,expected.rng);
  const elapsedMs=g.state.elapsedMs;
  assert.equal(g.canUndo(),true);assert.equal(g.undo(),true);
  assertTurnRestored(g,expected,elapsedMs,1);
  assert.deepEqual(g.drainEvents(),[{type:'undo',undoCount:1}]);
  assert.equal(g.canUndo(),false);assert.equal(g.undo(),false);
  const replay=E.Game.restore({...g.serialize(),undoCount:0});
  g.hold();replay.hold();g.hardDrop();replay.hardDrop();
  for(const key of ['board','holdType','queue','bag','rng','score','lines','pieces']) assert.deepEqual(g.state[key],replay.state[key]);
});

test('undo restores an occupied hold and can undo again after a replacement', () => {
  const g=fresh();g.hold();g.hardDrop();
  const expected=structuredClone(g.state);
  g.move(1);g.rotate(1);g.hold();g.hardDrop();
  assert.equal(g.undo(),true);assertTurnRestored(g,expected,0,1);
  g.move(-1);g.hardDrop();assert.equal(g.undo(),true);
  assertTurnRestored(g,expected,0,2);
  assert.equal(g.undo(),true);assert.equal(g.state.pieces,0);
  assert.equal(g.state.holdType,null);assert.equal(g.state.undoCount,3);
});

test('undo rewinds line clears, combo, back-to-back, level, and perfect-clear statistics', () => {
  const setup=fresh();tetrisWell(setup);
  setup.state.lines=9;setup.state.b2b=true;setup.state.b2bCount=2;
  setup.state.combo=3;setup.state.tetrises=2;setup.state.score=7000;
  const g=legacyCheckpoint(setup), expected=structuredClone(g.state);
  g.hardDrop();assert.equal(g.state.level,2);assert.equal(g.state.lines,13);
  assert.equal(g.state.lastClear.b2b,true);assert.equal(g.state.tetrises,3);
  g.undo();assertTurnRestored(g,expected,0,1);
  const perfectSetup=fresh();
  for(let y=22;y<24;y++) for(let x=0;x<10;x++) if(x!==4&&x!==5) perfectSetup.state.board[y][x]='L';
  active(perfectSetup,'O',3,22);
  const perfect=legacyCheckpoint(perfectSetup), before=structuredClone(perfect.state);
  perfect.hardDrop();assert.equal(perfect.state.lastClear.perfect,true);
  perfect.undo();assertTurnRestored(perfect,before,0,1);
});

test('automatic locking creates undo history without rewinding elapsed time', () => {
  const g=fresh(), before=structuredClone(g.state);
  const duration=(E.ghostY(g)-g.state.active.y)*E.gravityMs(g.state.level,g.state.mode)+g.config.lockDelay;
  g.tick(duration);assert.equal(g.state.pieces,1);assert.equal(g.canUndo(),true);
  g.tick(81);const elapsedMs=g.state.elapsedMs;
  g.undo();assertTurnRestored(g,before,elapsedMs,1);
  g.hardDrop();g.pause();g.undo();
  assertTurnRestored(g,before,elapsedMs,2,'paused');
  const paused=g.serialize();g.tick(1000);assert.deepEqual(g.serialize(),paused);
});

test('undo history and the pre-hold turn survive closing and restoring', () => {
  const g=fresh();g.hardDrop();const before=structuredClone(g.state);
  g.tick(51);g.move(-1);g.hold();g.softDrop();g.pause();
  const restored=E.Game.restore(JSON.stringify(g.serialize()));
  assert.deepEqual(restored.serialize(),g.serialize());
  restored.resume();restored.hardDrop();restored.tick(67);
  const elapsedMs=restored.state.elapsedMs;
  restored.undo();assertTurnRestored(restored,before,elapsedMs,1);
  assert.equal(restored.canUndo(),true);
  const secondRestore=E.Game.restore(restored.serialize());
  secondRestore.undo();assert.equal(secondRestore.state.pieces,0);
  assert.equal(secondRestore.state.undoCount,2);assert.equal(secondRestore.state.elapsedMs,elapsedMs);
});

test('history retains at most 30 turns, with no recursive snapshots', () => {
  const g=fresh();
  for(let i=0;i<38;i++) {
    clearBoard(g);g.hardDrop();
  }
  const saved=g.serialize();
  assert.equal(saved.undoHistory.length,30);
  assert.ok(saved.undoHistory.every(turn=>!('undoHistory' in turn)&&!('turnStart' in turn)));
  assert.ok(!('undoHistory' in saved.turnStart)&&!('turnStart' in saved.turnStart));
  const restored=E.Game.restore(saved);
  for(let i=0;i<30;i++) assert.equal(restored.undo(),true);
  assert.equal(restored.state.pieces,8);assert.equal(restored.state.undoCount,30);
  assert.equal(restored.undo(),false);
});

test('undo can recover from topout and sprint completion and leaves the game paused', () => {
  const setup=fresh();clearBoard(setup);active(setup,'O',3,1);
  setup.state.board[3][4]='J';setup.state.board[3][5]='J';
  const g=legacyCheckpoint(setup), before=structuredClone(g.state);
  g.hardDrop();assert.equal(g.state.endReason,'lockout');
  const restored=E.Game.restore(g.serialize());
  assert.equal(restored.undo(),true);assertTurnRestored(restored,before,0,1,'paused');
  const sprintSetup=fresh({mode:'sprint'});sprintSetup.state.lines=36;sprintSetup.state.level=4;tetrisWell(sprintSetup);
  const sprint=legacyCheckpoint(sprintSetup);sprint.hardDrop();
  assert.equal(sprint.state.status,'won');assert.equal(sprint.undo(),true);
  assert.equal(sprint.state.status,'paused');assert.equal(sprint.state.lines,36);
  assert.equal(sprint.resume(),true);
});

test('ultra undo never restores spent time and cannot undo its final timeout', () => {
  const g=fresh({mode:'ultra'});g.hardDrop();g.tick(1100);g.undo();
  assert.equal(g.state.elapsedMs,1100);assert.equal(g.state.undoCount,1);
  g.hardDrop();g.state.elapsedMs=119999;g.tick(1);
  assert.equal(g.state.endReason,'time');assert.equal(g.canUndo(),false);
  const saved=g.serialize();assert.equal(g.undo(),false);assert.deepEqual(g.serialize(),saved);
  const restored=E.Game.restore(saved);assert.equal(restored.undo(),false);
});

test('old version-one saves remain playable and gain history from their next lock', () => {
  const g=fresh();g.move(-1);g.softDrop();g.tick(137);g.pause();
  const restored=legacyCheckpoint(g);
  assert.equal(restored.state.undoCount,0);assert.equal(restored.canUndo(),false);
  restored.resume();const before=structuredClone(restored.state);
  restored.hardDrop();assert.equal(restored.undo(),true);
  assertTurnRestored(restored,before,137,1);
  const ready=new E.Game({seed:0}).serialize();delete ready.undoHistory;delete ready.turnStart;delete ready.undoCount;
  const oldReady=E.Game.restore(ready);assert.equal(oldReady.start(),true);assert.equal(oldReady.canUndo(),false);
});

test('recursive, excessive, mismatched, and damaged undo history is rejected', () => {
  const g=fresh();g.hardDrop();const original=g.serialize();
  const mutations=[
    s=>{s.undoCount=-1;},s=>{s.undoHistory={};},s=>{s.undoHistory=Array(31).fill(s.undoHistory[0]);},
    s=>{s.undoHistory[0].undoHistory=[];},s=>{s.undoHistory[0].turnStart=null;},
    s=>{s.undoHistory[0].board[0][0]='evil';},s=>{s.undoHistory[0].active.x=-9;},
    s=>{s.undoHistory[0].config.seed++;},s=>{s.undoHistory[0].status='paused';},
    s=>{s.turnStart=null;},s=>{s.turnStart.active.rotation=4;},
    s=>{s.turnStart.config.extra={turnStart:s.turnStart};}
  ];
  for(const mutate of mutations) {const s=structuredClone(original);mutate(s);assert.throws(()=>E.Game.restore(s));}
  assert.throws(()=>E.Game.restore(' '.repeat(262145)));
  const cyclic=structuredClone(original);cyclic.undoHistory[0].undoHistory=[cyclic];
  assert.throws(()=>E.Game.restore(cyclic));
  assert.deepEqual(E.Game.restore(original).serialize(),original);
});
