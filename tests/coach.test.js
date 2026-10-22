'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../engine.js');
const C=require('../coach.js');
const edgeBankFixtures=require('./fixtures/coach-edge-bank.json').cases;
const spinDetourFixtures=require('./fixtures/coach-spin0-detours.json').cases;
const {runGame}=require('../scripts/benchmark-coach.js');
const timeless={now:()=>0,budgetMs:1,maxDepth:1};
function fresh(mode='marathon') {
  const g=new E.Game({seed:123456,mode});g.start();g.drainEvents();return g;
}
function setActive(g,type,x=3,y=3,rotation=0) {
  g.state.active={type,x,y,rotation};g.state.lastAction=null;g.state.lastKick=-1;
}
function well(g,column=9) {
  g.state.board=Array.from({length:E.ROWS},()=>Array(E.COLS).fill(null));
  for (let y=20;y<24;y++) for (let x=0;x<10;x++) if(x!==column)g.state.board[y][x]='J';
  g.state.board[19][0]='S';
}
function replay(g,move) {
  for (const name of move.path) {
    if(name==='left')assert.equal(g.move(-1),true);
    else if(name==='right')assert.equal(g.move(1),true);
    else if(name==='cw')assert.equal(g.rotate(1),true);
    else if(name==='ccw')assert.equal(g.rotate(-1),true);
    else if(name==='soft')assert.equal(g.softDrop(),true);
    else if(name==='hold')assert.equal(g.hold(),true);
    else if(name==='hard') {
      assert.deepEqual({...g.state.active,y:E.ghostY(g)},move.piece);
      g.hardDrop();
    } else assert.fail('unknown move '+name);
  }
}
function cloneGame(g) {
  const clone=fresh(g.state.mode);
  clone.state=JSON.parse(JSON.stringify(g.state));clone._turnStart=null;
  return clone;
}
function profile(g,heights) {
  g.state.board=Array.from({length:E.ROWS},()=>Array(E.COLS).fill(null));
  for(let x=0;x<E.COLS;x++)for(let y=E.ROWS-heights[x];y<E.ROWS;y++)g.state.board[y][x]='J';
}
function bankSetup(g) {
  profile(g,[4,4,4,4,4,4,3,3,3,0]);
  setActive(g,'I');g.state.holdType='T';g.state.queue=['O','J','L','I','Z','S'];
}
function spinDouble(g) {
  setActive(g,'T');g.state.canHold=false;
  for(let x=0;x<E.COLS;x++) {
    if(x<3||x>5)g.state.board[22][x]='J';
    if(x!==4)g.state.board[23][x]='J';
  }
  g.state.board[21][3]='J';
}
function edgePit(g,column) {
  g.state.board=Array.from({length:E.ROWS},()=>Array(E.COLS).fill(null));
  for(let x=0;x<E.COLS;x++)if(x!==column)g.state.board[23][x]='J';
  // Clearing this row relieves a high stack, so this exercises route choice
  // for a useful single rather than asking the coach to spend a safe bank.
  for(let y=9;y<23;y++)g.state.board[y][column===0?7:2]='J';
}
function cellKey(move){return move.cells.map(cell=>cell.x+','+cell.y).sort().join(';');}

test('recommends a reachable four-line clear in the open well',()=>{
  const g=fresh();well(g);setActive(g,'I');g.state.canHold=false;
  const r=C.analyze(g.state,timeless);
  assert.equal(r.metrics.lines,4);assert.equal(r.move.hold,false);assert.match(r.reason,/四行/);
  const actual=cloneGame(g);replay(actual,r.move);
  assert.equal(actual.state.lastClear.lines,4);
  assert.deepEqual(actual.state.board,C.applyPath(g.state,r.move).board);
});

test('prefers filling the row without introducing holes',()=>{
  const g=fresh();setActive(g,'O');g.state.canHold=false;
  for(let x=0;x<10;x++)if(x!==4&&x!==5)g.state.board[23][x]='J';
  const r=C.analyze(g.state,timeless);
  assert.equal(r.metrics.lines,1);assert.equal(r.metrics.holes,0);
  assert.equal(C.applyPath(g.state,r.move).valid,true);
});

test('can recommend existing hold and empty hold, respecting canHold',()=>{
  const g=fresh();well(g);setActive(g,'O');g.state.holdType='I';
  let r=C.analyze(g.state,timeless);
  assert.equal(r.move.hold,true);assert.equal(r.move.path[0],'hold');assert.equal(r.metrics.lines,4);
  let actual=cloneGame(g);replay(actual,r.move);assert.equal(actual.state.lastClear.lines,4);
  g.state.holdType=null;g.state.queue=['I','O','T','S','L','Z'];
  r=C.analyze(g.state,timeless);
  assert.equal(r.move.hold,true);assert.equal(r.metrics.lines,4);
  actual=cloneGame(g);replay(actual,r.move);
  assert.deepEqual(actual.state.board,C.applyPath(g.state,r.move).board);
  g.state.canHold=false;
  r=C.analyze(g.state,timeless);assert.equal(r.move.hold,false);
});

test('classic uses one preview and never offers hold',()=>{
  const g=fresh('classic');well(g);setActive(g,'O');g.state.holdType='I';g.state.queue=['O','I','I','I','I','I'];
  const r=C.analyze(g.state,{...timeless,maxDepth:6});
  assert.equal(r.visiblePieces,1);assert.equal(r.move.hold,false);assert.ok(r.depth<=2);
  const alternate={...g.state,queue:['O','T','T','T','T','T']};
  assert.deepEqual(C.analyze(alternate,{...timeless,maxDepth:6}),r);
});

test('does not read RNG, bag, hidden sixth piece or undo history',()=>{
  const g=fresh();const v={...g.state};
  for(const key of ['rng','bag','undoHistory','turnStart'])Object.defineProperty(v,key,{get(){throw Error('private data read: '+key);}});
  v.queue=g.state.queue.slice();
  Object.defineProperty(v.queue,5,{get(){throw Error('sixth piece read');}});
  const a=C.analyze(v,{...timeless,maxDepth:3});
  const b=C.analyze({...g.state,rng:111,bag:['O'],undoHistory:[1,2],queue:[...g.state.queue.slice(0,5),'O']},{...timeless,maxDepth:3});
  assert.deepEqual(a,b);assert.equal(a.knownOnly,true);assert.equal(a.visiblePieces,5);
});

test('searches all five visible future pieces when budget permits, without inventing unknowns',()=>{
  const g=fresh();setActive(g,'O');g.state.canHold=false;
  g.state.queue=['O','O','O','O','O','S'];
  const a=C.analyze(g.state,{...timeless,maxDepth:6});
  assert.equal(a.depth,6);
  g.state.queue=['T','T','T','T','T','S'];
  const b=C.analyze(g.state,{...timeless,maxDepth:6});
  assert.equal(b.depth,6);
  assert.notEqual(a.metrics.value,b.metrics.value,'the future affects the evaluated horizon even when the same opening move stays best');
  g.state.queue=[];
  assert.equal(C.analyze(g.state,{...timeless,maxDepth:6}).depth,1);
});

test('all suggested moves replay through the real engine across every mode and tetromino',()=>{
  for(const mode of E.MODES)for(const type of E.TYPES) {
    const g=fresh(mode);setActive(g,type);g.state.holdType='T';
    const heights=[2,3,1,0,2,1,4,2,3,1];
    for(let x=0;x<10;x++)for(let y=24-heights[x];y<24;y++)g.state.board[y][x]='J';
    const before=JSON.stringify(g.state);
    const r=C.analyze(g.state,timeless);
    assert.ok(r.move);assert.equal(JSON.stringify(g.state),before);
    const simulation=C.applyPath(g.state,r.move);
    assert.equal(simulation.valid,true,mode+'/'+type);
    const actual=cloneGame(g);replay(actual,r.move);
    assert.deepEqual(actual.state.board,simulation.board);
    assert.deepEqual(actual.state.lastClear,simulation.clear);
  }
});

test('enumerates legal wall/floor kicks and tucks from the actual low piece',()=>{
  for(const mode of ['marathon','classic']) {
    const g=fresh(mode);setActive(g,'T',-1,18,1);g.state.canHold=false;
    for(let x=2;x<10;x++)g.state.board[23][x]='L';
    g.state.board[21][2]='J';
    const found=C.enumeratePlacements(g.state,{...timeless,budgetMs:1000});
    assert.ok(found.length>5);
    for(const candidate of found) {
      const actual=cloneGame(g);replay(actual,candidate.move);
      assert.deepEqual(actual.state.lastClear,candidate.clear);
    }
    if(mode==='marathon')assert.ok(found.some(c=>c.move.path.some(k=>k==='cw'||k==='ccw')));
  }
});

test('T-spin classification and points match engine including last successful rotation',()=>{
  const g=fresh('ultra');setActive(g,'T',3,21,0);g.state.canHold=false;
  for(const [x,y]of[[3,21],[5,21],[3,23]])g.state.board[y][x]='J';
  g.state.lastAction='rotate';g.state.lastKick=4;
  const placements=C.enumeratePlacements(g.state,{...timeless,budgetMs:1000});
  const spin=placements.find(c=>c.move.path.length===1 && c.clear.spin==='full');
  assert.ok(spin);assert.equal(spin.clear.points,400);
  const actual=cloneGame(g);replay(actual,spin.move);assert.deepEqual(actual.state.lastClear,spin.clear);
});

test('zero and exhausted budgets retain a legal fallback and report only completed depth',()=>{
  const g=fresh();
  const zero=C.analyze(g.state,{now:()=>0,budgetMs:0,maxDepth:6});
  assert.equal(zero.depth,1);assert.equal(zero.rootComplete,false);assert.equal(zero.budgetLimited,true);
  assert.equal(C.applyPath(g.state,zero.move).valid,true);
  let time=0;
  const cut=C.analyze(g.state,{now:()=>time++,budgetMs:5,maxDepth:6});
  assert.equal(cut.depth,1);assert.equal(cut.budgetLimited,true);assert.equal(C.applyPath(g.state,cut.move).valid,true);
  const limit=C.analyze(g.state,{...timeless,maxDepth:6,maxNodes:10});
  assert.equal(limit.budgetLimited,true);assert.ok(limit.nodes<=32);
});

test('same public position and deterministic budget yield identical results without mutation',()=>{
  const g=fresh();const input=JSON.parse(JSON.stringify(g.state));
  const before=JSON.stringify(input);
  for(const row of input.board)Object.freeze(row);Object.freeze(input.board);Object.freeze(input.active);Object.freeze(input.queue);Object.freeze(input);
  const a=C.analyze(input,{...timeless,maxDepth:4});
  const b=C.analyze(input,{...timeless,maxDepth:4});
  assert.deepEqual(a,b);assert.equal(JSON.stringify(input),before);
});

test('invalid views fail safely and applyPath rejects impossible paths',()=>{
  const g=fresh();
  assert.equal(C.analyze(null).move,null);
  assert.equal(C.analyze({...g.state,active:{type:'T',x:100,y:3,rotation:0}}).move,null);
  const invalid=Array.from({length:24},()=>Array(10));
  assert.equal(C.analyze({...g.state,board:invalid}).move,null);
  assert.equal(C.applyPath(g.state,{hold:false,path:['hard','left']}).valid,false);
  assert.equal(C.applyPath(g.state,{hold:true,path:['hold','hold','hard']}).valid,false);
});

test('banks a safe edge well instead of taking an available single or triple, then scores a Tetris',()=>{
  const g=fresh();bankSetup(g);
  const choices=C.enumeratePlacements(g.state,timeless);
  assert.ok(choices.some(choice=>choice.clear.lines===1));
  assert.ok(choices.some(choice=>choice.clear.lines===3));
  const first=C.analyze(g.state,{...timeless,maxDepth:3});
  assert.equal(first.metrics.lines,0);assert.equal(first.metrics.holes,0);
  assert.ok(first.metrics.wells.some(w=>w.x===9&&w.ready>=3));
  replay(g,first.move);
  for(let step=0;step<3&&g.state.tetrises===0;step++){
    const finish=C.analyze(g.state,{...timeless,maxDepth:3});
    assert.equal(finish.metrics.holes,0);
    assert.ok(finish.metrics.lines===0||finish.metrics.lines===4,'safe setup should not cash the bank in early');
    replay(g,finish.move);
  }
  assert.equal(g.state.lastClear.lines,4);
  assert.equal(g.state.tetrises,1);
});

test('new comparable wells favor an edge but an established central well is retained',()=>{
  const empty=fresh();setActive(empty,'O');empty.state.canHold=false;
  const start=C.analyze(empty.state,timeless);
  assert.ok(start.metrics.wells.some(w=>w.edge));
  assert.equal(start.metrics.holes,0);
  const central=fresh();profile(central,[3,3,3,3,0,3,3,3,3,3]);
  setActive(central,'O');central.state.canHold=false;
  const keep=C.analyze(central.state,{...timeless,maxDepth:3});
  assert.equal(keep.metrics.holes,0);
  assert.ok(keep.metrics.wells.some(w=>w.x===4&&w.ready>=3));
  assert.ok(keep.move.cells.every(cell=>cell.x!==4));
  const clear=fresh();well(clear,4);setActive(clear,'I');clear.state.canHold=false;
  const finish=C.analyze(clear.state,timeless);
  assert.equal(finish.metrics.lines,4);assert.ok(finish.move.cells.every(cell=>cell.x===4));
});

test('danger overrides banking and a clean necessary single is still taken',()=>{
  const high=fresh();profile(high,[17,17,17,17,17,17,16,16,16,0]);
  setActive(high,'I');high.state.holdType='T';high.state.queue=['O','J','L','I','Z','S'];
  const rescue=C.analyze(high.state,{...timeless,maxDepth:3});
  assert.equal(rescue.metrics.lines,4);assert.equal(rescue.move.hold,false);
  assert.equal(rescue.metrics.holes,0);assert.ok(rescue.metrics.maxHeight<17);
  replay(high,rescue.move);assert.equal(high.state.lastClear.lines,4);
  const single=fresh();setActive(single,'O');single.state.canHold=false;
  for(let x=0;x<E.COLS;x++)if(x!==4&&x!==5)single.state.board[23][x]='J';
  const repair=C.analyze(single.state,timeless);
  assert.equal(repair.metrics.lines,1);assert.equal(repair.metrics.holes,0);
});

test('real low-stack positions usually grow an available shallow edge bank instead of cashing it early',()=>{
  let banked=0;
  const decisions=[];
  for(const fixture of edgeBankFixtures){
    const before=C.inspect(fixture.view.board),alternative=C.applyPath(fixture.view,fixture.bankAlternative.move);
    assert.equal(before.holes,0,fixture.id);assert.ok(before.maxHeight<=5,fixture.id);
    assert.equal(alternative.valid,true,fixture.id+' has a real, reachable banking alternative');
    assert.equal(C.inspect(alternative.board).holes,0,fixture.id);
    const result=C.analyze(fixture.view,{...timeless,maxDepth:3,beamWidth:5});
    assert.equal(C.applyPath(fixture.view,result.move).valid,true,fixture.id);
    assert.equal(result.metrics.topOut,false,fixture.id);
    const retained=result.metrics.lines===0&&result.metrics.holes===0&&result.metrics.wells.some(well=>well.x===fixture.well.x&&well.ready>=fixture.well.ready);
    const valuable=result.metrics.perfect||result.metrics.spin||result.metrics.lines===4;
    if(retained||valuable)banked++;
    decisions.push({id:fixture.id,lines:result.metrics.lines,holes:result.metrics.holes,retained,valuable:!!valuable});
  }
  // These are several unrelated real positions, not a mandate to preserve one
  // column forever. A strong spin or perfect clear may replace the bank.
  assert.ok(banked>=3,'safe banking should be the normal choice: '+JSON.stringify(decisions));
});

test('a necessary single opens a buried hole even when the coach favors larger clears',()=>{
  for(const maxDepth of [1,3]){
    const g=fresh();setActive(g,'I');g.state.canHold=false;
    for(let x=4;x<E.COLS;x++)g.state.board[22][x]='J';
    for(let x=0;x<E.COLS;x++)if(x!==4)g.state.board[23][x]='J';
    assert.equal(C.inspect(g.state.board).holes,1);
    const result=C.analyze(g.state,{...timeless,maxDepth});
    assert.equal(result.metrics.lines,1);assert.equal(result.metrics.holes,0);
    const actual=cloneGame(g);replay(actual,result.move);
    assert.equal(actual.state.lastClear.lines,1);assert.equal(C.inspect(actual.state.board).holes,0);
  }
});

test('building a four-line bank never displaces an available clean full T-Spin or perfect clear',()=>{
  for(const maxDepth of [1,3]){
    const spin=fresh();spinDouble(spin);
    const result=C.analyze(spin.state,{...timeless,maxDepth});
    assert.equal(result.metrics.spin,'full');assert.equal(result.metrics.lines,2);
    assert.equal(result.metrics.holes,0);
    const perfect=fresh();setActive(perfect,'O');perfect.state.canHold=false;
    for(let y=22;y<E.ROWS;y++)for(let x=0;x<E.COLS;x++)if(x!==4&&x!==5)perfect.state.board[y][x]='J';
    const finish=C.analyze(perfect.state,{...timeless,maxDepth});
    assert.equal(finish.metrics.perfect,true);assert.equal(finish.metrics.lines,2);
    assert.ok(C.applyPath(perfect.state,finish.move).board.every(row=>row.every(cell=>cell===null)));
  }
});

test('from an empty field, several complete piece streams establish an edge bank and collect Tetrises safely',()=>{
  const options={now:()=>0,budgetMs:1,maxDepth:6,beamWidth:5,maxNodes:12000};
  const runs=[1,7,42].map(seed=>runGame(C,seed,96,options));
  for(const run of runs){
    assert.equal(run.pieces,96,JSON.stringify(run));
    assert.equal(run.status,'running',JSON.stringify(run));
    assert.ok(run.tetrises>=1,'an opening should eventually realize a bank: '+JSON.stringify(run));
    assert.ok(run.meanHoles<=1.5,'banking must keep repairable terrain: '+JSON.stringify(run));
    assert.ok(run.maxHeight<=16,'banking must not require a near top-out stack: '+JSON.stringify(run));
  }
  const fourLineTotal=runs.reduce((sum,run)=>sum+run.tetrises*4,0),lineTotal=runs.reduce((sum,run)=>sum+run.lines,0);
  assert.ok(fourLineTotal>=lineTotal*.5,'safe ordinary streams should make four-line banking a main scoring route: '+JSON.stringify(runs));
  assert.ok(runs.reduce((sum,run)=>sum+run.earlyEdgeWellTurns,0)>=30,JSON.stringify(runs));
});

test('actual scoring values T-Spins, four-line efficiency, B2B and level normalization',()=>{
  const single=fresh();setActive(single,'O');single.state.canHold=false;
  for(let x=0;x<E.COLS;x++)if(x!==4&&x!==5)single.state.board[23][x]='J';
  const one=C.analyze(single.state,timeless);
  const four=fresh();well(four);setActive(four,'I');four.state.canHold=false;
  const tetris=C.analyze(four.state,timeless);
  assert.ok(tetris.metrics.scoreReward>one.metrics.scoreReward*4);
  const spin=fresh();spinDouble(spin);
  const normal=C.analyze(spin.state,timeless);
  assert.equal(normal.metrics.spin,'full');assert.equal(normal.metrics.lines,2);
  assert.equal(normal.metrics.points,1200);
  assert.ok(normal.metrics.scoreReward>tetris.metrics.scoreReward);
  const actual=cloneGame(spin);replay(actual,normal.move);
  assert.equal(actual.state.lastClear.points,1200);
  spin.state.b2b=true;
  const chain=C.analyze(spin.state,timeless);
  assert.equal(chain.metrics.points,1800);assert.equal(chain.metrics.b2b,true);
  assert.ok(chain.metrics.scoreReward>normal.metrics.scoreReward);
  assert.deepEqual(chain.move,normal.move);
  spin.state.level=10;
  const level=C.analyze(spin.state,timeless);
  assert.deepEqual(level.move,chain.move);
  assert.equal(level.metrics.scoreReward,chain.metrics.scoreReward);
});

test('real zero-line Mini detours do not outweigh a direct placement with the same final cells',()=>{
  for(const fixture of spinDetourFixtures){
    const slow=C.applyPath(fixture.view,fixture.slow.move),fast=C.applyPath(fixture.view,fixture.fast.move);
    assert.equal(slow.valid,true,fixture.id);assert.equal(fast.valid,true,fixture.id);
    assert.deepEqual(slow.board,fast.board,fixture.id+' has identical terrain after both routes');
    assert.equal(slow.clear.lines,0);assert.equal(slow.clear.spin,'mini');
    assert.equal(fast.clear.lines,0);assert.equal(fast.clear.spin,null);
    assert.ok(slow.clear.points>fast.clear.points,'Spin zero remains legal engine scoring');
    assert.ok(fixture.slow.move.path.filter(step=>step==='soft').length>=14);
    assert.equal(fixture.fast.move.path.includes('soft'),false);
    const selected=C.analyze(fixture.view,{now:()=>0,budgetMs:1,maxNodes:12000,maxDepth:6,beamWidth:5});
    assert.equal(C.applyPath(fixture.view,selected.move).valid,true,fixture.id);
    if(selected.metrics.lines===0&&selected.metrics.spin){
      const samePlaceFast=C.enumeratePlacements(fixture.view,timeless).find(candidate=>!candidate.clear.spin&&
        cellKey(candidate.move)===cellKey(selected.move)&&!candidate.move.path.includes('soft'));
      assert.ok(!samePlaceFast||!selected.move.path.includes('soft'),fixture.id+' should not slowly descend for a decorative zero-line spin');
    }
  }
});

test('routeTo takes the direct route to a non-spin target even when its old path contains a zero-line spin detour',()=>{
  for(const fixture of spinDetourFixtures){
    assert.deepEqual(fixture.slow.move.piece,fixture.fast.move.piece);
    const target={...fixture.fast.move,path:fixture.slow.move.path.slice()};
    const route=C.routeTo(fixture.view,target,{now:()=>0,budgetMs:1,maxNodes:10000});
    assert.ok(route,fixture.id);assert.deepEqual(route.piece,target.piece);
    assert.deepEqual(route.cells,target.cells);
    assert.equal(route.path.includes('soft'),false,fixture.id+' does not inherit obsolete soft drops');
    const actual=C.applyPath(fixture.view,route);
    assert.equal(actual.valid,true);assert.deepEqual(actual.board,C.applyPath(fixture.view,fixture.fast.move).board);
  }
});

test('both edge pits use a direct rotation and hard drop instead of a scoring Mini Single detour',()=>{
  for(const edge of [0,9])for(const b2b of [false,true])for(const mode of ['marathon','sprint','ultra','zen']){
    const g=fresh(mode);edgePit(g,edge);setActive(g,'T');g.state.canHold=false;g.state.b2b=b2b;
    const placements=C.enumeratePlacements(g.state,timeless);
    const target={type:'T',x:edge===0?-1:8,y:21,rotation:edge===0?1:3};
    const sameTarget=item=>JSON.stringify(item.move.piece)===JSON.stringify(target);
    const fast=placements.find(item=>sameTarget(item)&&!item.move.path.includes('soft'));
    const slow=placements.find(item=>sameTarget(item)&&item.clear.spin==='mini');
    assert.ok(fast);assert.ok(slow);assert.ok(slow.move.path.filter(step=>step==='soft').length>=18);
    assert.equal(fast.clear.lines,1);assert.equal(fast.clear.spin,null);assert.equal(fast.clear.points,100);
    assert.equal(slow.clear.points,b2b?300:200,'the slower Mini still receives its real engine score');
    assert.deepEqual(C.applyPath(g.state,fast.move).board,C.applyPath(g.state,slow.move).board);

    const selected=C.analyze(g.state,timeless);
    assert.deepEqual(selected.move.piece,target,mode+' edge '+edge+' b2b '+b2b);
    assert.equal(selected.move.path.includes('soft'),false);assert.ok(selected.move.path.length<=7);
    assert.equal(selected.metrics.spin,null);assert.equal(selected.metrics.points,100);
    assert.equal(selected.metrics.b2b,false,'the search uses the direct route’s actual chain state');
    const actual=cloneGame(g);replay(actual,selected.move);
    assert.equal(actual.state.lastClear.spin,null);assert.equal(actual.state.lastClear.points,100);
    assert.equal(actual.state.b2b,false);
  }
});

test('a direct edge-pit target remains direct and unchanged across a real hold and later rerouting',()=>{
  for(const edge of [0,9]){
    const g=fresh();edgePit(g,edge);setActive(g,'O');g.state.holdType='T';g.state.canHold=true;g.state.b2b=true;
    const selected=C.analyze(g.state,timeless);
    assert.equal(selected.move.hold,true);assert.equal(selected.metrics.spin,null);assert.equal(selected.metrics.points,100);
    assert.equal(selected.move.path.includes('soft'),false);
    const before=C.routeTo(g.state,selected.move,{spin:selected.metrics.spin});
    assert.ok(before);assert.deepEqual(before.piece,selected.move.piece);assert.equal(before.path.includes('soft'),false);
    const expected=C.applyPath(g.state,before);assert.equal(expected.valid,true);
    assert.equal(g.hold(),true);g.move(edge===0?-1:1);g.softDrop();
    const after=C.routeTo(g.state,{...selected.move,hold:false,path:selected.move.path.slice(1)},{spin:selected.metrics.spin});
    assert.ok(after);assert.deepEqual(after.piece,selected.move.piece);assert.equal(after.path.includes('soft'),false);
    const actual=C.applyPath(g.state,after);
    assert.equal(actual.valid,true);assert.equal(actual.clear.spin,null);assert.equal(actual.clear.points,100);
    assert.deepEqual(actual.board,expected.board);
  }
});

test('positive full T-Spin clears and genuinely necessary non-T tucks retain their soft-drop access paths',()=>{
  const spin=fresh();spinDouble(spin);
  const positive=C.analyze(spin.state,{...timeless,maxDepth:3});
  assert.equal(positive.metrics.spin,'full');assert.equal(positive.metrics.lines,2);
  assert.ok(positive.move.path.includes('soft'),'the roof requires descending before the final rotation');
  const spinRoute=C.routeTo(spin.state,positive.move,{now:()=>0,budgetMs:1,maxNodes:10000,spin:'full'});
  assert.ok(spinRoute);assert.deepEqual(spinRoute.piece,positive.move.piece);
  assert.equal(C.applyPath(spin.state,spinRoute).clear.points,1200);
  const actualSpin=cloneGame(spin);replay(actualSpin,spinRoute);
  assert.equal(actualSpin.state.lastClear.spin,'full');assert.equal(actualSpin.state.lastClear.lines,2);

  const tuck=fresh();setActive(tuck,'J');tuck.state.canHold=false;
  tuck.state.board[21][3]='J';
  for(let x=0;x<E.COLS;x++){
    if(x<3||x>5)tuck.state.board[22][x]='J';
    if(x!==4&&x!==5)tuck.state.board[23][x]='J';
  }
  assert.equal(C.inspect(tuck.state.board).holes,1);
  const necessary=C.analyze(tuck.state,timeless);
  assert.equal(necessary.metrics.lines,1);assert.equal(necessary.metrics.spin,null);
  assert.equal(necessary.metrics.holes,0);assert.ok(necessary.move.path.includes('soft'));
  const direct=C.enumeratePlacements(tuck.state,timeless).find(candidate=>cellKey(candidate.move)===cellKey(necessary.move)&&!candidate.move.path.includes('soft'));
  assert.equal(direct,undefined,'this tuck cannot be replaced with a direct descent');
  const actualTuck=cloneGame(tuck);replay(actualTuck,necessary.move);
  assert.equal(actualTuck.state.lastClear.lines,1);assert.equal(C.inspect(actualTuck.state.board).holes,0);
});

test('an inaccessible full T-Spin Triple retains its necessary descent and fifth-kick rotation',()=>{
  const g=fresh();setActive(g,'T');g.state.canHold=false;
  for(let y=21;y<E.ROWS;y++)for(let x=0;x<E.COLS;x++)if(x!==4&&!(y===22&&x===5))g.state.board[y][x]='J';
  g.state.board[19][4]='J';
  const selected=C.analyze(g.state,{...timeless,maxDepth:3});
  assert.equal(selected.metrics.lines,3);assert.equal(selected.metrics.spin,'full');assert.equal(selected.metrics.points,1600);
  assert.ok(selected.move.path.includes('soft'));
  assert.equal(C.enumeratePlacements(g.state,timeless).some(item=>cellKey(item.move)===cellKey(selected.move)&&
    !item.move.path.includes('soft')),false,'the roof prevents a direct drop to the triple');
  const route=C.routeTo(g.state,selected.move,{now:()=>0,budgetMs:1,maxNodes:10000,spin:'full'});
  assert.ok(route);assert.deepEqual(route.piece,selected.move.piece);
  const actual=C.applyPath(g.state,route);
  assert.equal(actual.valid,true);assert.equal(actual.clear.spin,'full');assert.equal(actual.clear.points,1600);
  const game=cloneGame(g);replay(game,{...route,path:route.path.slice(0,-1)});
  assert.equal(game.state.lastAction,'rotate');assert.equal(game.state.lastKick,4);
  assert.equal(game.hardDrop(),0);
  assert.equal(game.state.lastClear.lines,3);assert.equal(game.state.lastClear.points,1600);
});

test('routeTo changes only the path after movement, rotation and descent',()=>{
  const g=fresh();setActive(g,'L');g.state.canHold=false;
  const target=C.analyze(g.state,timeless).move;
  g.move(1);g.rotate(1);g.softDrop();g.softDrop();
  const before=JSON.stringify(g.state),route=C.routeTo(g.state,target);
  assert.ok(route);assert.deepEqual(route.piece,target.piece);assert.deepEqual(route.cells,target.cells);
  assert.equal(C.applyPath(g.state,route).valid,true);assert.equal(JSON.stringify(g.state),before);
  replay(g,route);
});

test('routeTo retains the same held target before and after an actual hold',()=>{
  const g=fresh();well(g);setActive(g,'O');g.state.holdType='I';
  const target=C.analyze(g.state,timeless).move;
  assert.equal(target.hold,true);
  const before=C.routeTo(g.state,target);assert.ok(before);assert.equal(before.path[0],'hold');
  assert.equal(C.applyPath(g.state,before).clear.lines,4);
  assert.equal(g.hold(),true);
  const after=C.routeTo(g.state,{...target,hold:false,path:target.path.slice(1)});
  assert.ok(after);assert.equal(after.hold,false);assert.deepEqual(after.piece,target.piece);
  assert.equal(C.applyPath(g.state,after).clear.lines,4);
});

test('routeTo preserves a planned full T-Spin after movement and rotations',()=>{
  const original=fresh();spinDouble(original);
  const target=C.analyze(original.state,timeless);
  for(let rotation=0;rotation<4;rotation++) {
    const g=cloneGame(original);setActive(g,'T',4,8,rotation);
    const route=C.routeTo(g.state,target.move,{spin:target.metrics.spin});
    assert.ok(route,'rotation '+rotation);assert.deepEqual(route.piece,target.move.piece);
    const result=C.applyPath(g.state,route);
    assert.equal(result.valid,true);assert.equal(result.clear.spin,'full');assert.equal(result.clear.points,1200);
    replay(g,route);assert.equal(g.state.lastClear.points,1200);
  }
});

test('routeTo reports an unreachable unchanged target and respects a search cutoff',()=>{
  const g=fresh();g.state.canHold=false;
  for(let y=18;y<24;y++)g.state.board[y][4]='J';
  setActive(g,'O',5,22);
  const target={piece:{type:'O',x:0,y:22,rotation:0},hold:false,path:['left','left','left','hard']};
  assert.equal(C.routeTo(g.state,target,{now:()=>0,budgetMs:1,maxNodes:1000}),null);
  const spin=fresh();spinDouble(spin);
  const destination=C.analyze(spin.state,timeless);
  const noPath={...destination.move,path:[]};
  assert.equal(C.routeTo(spin.state,noPath,{now:()=>0,budgetMs:0,spin:'full'}),null);
  const full=C.routeTo(spin.state,noPath,{now:()=>0,budgetMs:1,maxNodes:10000,spin:'full'});
  assert.ok(full);assert.equal(C.applyPath(spin.state,full).clear.spin,'full');
});
