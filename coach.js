/* Pixel Stack local coach. Searches only the board and visible public pieces. */
(function (root, factory) {
  const engine = typeof module === 'object' && module.exports ? require('./engine.js') : root.PixelEngine;
  const api = factory(engine);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PixelCoachCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';
  const {COLS, ROWS, HIDDEN_ROWS, SHAPES, TYPES, MODES, Game} = E;
  const clock = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
  const spawn = type => ({type, x: 3, y: HIDDEN_ROWS - 1, rotation: 0});
  const copyBoard = board => board.map(row => row.slice());
  const cells = piece => E.getCells(piece);
  function collision(board, piece) {
    const shape = piece && SHAPES[piece.type] && SHAPES[piece.type][piece.rotation];
    if (!shape) return true;
    for (let i = 0; i < 4; i++) {
      const x = piece.x + shape[i][0], y = piece.y + shape[i][1];
      if (x < 0 || x >= COLS || y < 0 || y >= ROWS || board[y][x] !== null) return true;
    }
    return false;
  }
  // Deliberately copy a whitelist. The engine's RNG, bag, sixth preview and
  // undo history are neither inspected nor carried into the search.
  function publicView(input) {
    if (!input || !Array.isArray(input.board) || input.board.length !== ROWS ||
      Array.from(input.board).some(row => !Array.isArray(row) || row.length !== COLS || Array.from(row).some(v => v !== null && !TYPES.includes(v)))) return null;
    const mode = MODES.includes(input.mode) ? input.mode : 'marathon';
    const p = input.active;
    if (!p || !TYPES.includes(p.type) || !Number.isInteger(p.x) || !Number.isInteger(p.y) ||
      !Number.isInteger(p.rotation) || p.rotation < 0 || p.rotation > 3) return null;
    const board = copyBoard(input.board), active = {type:p.type, x:p.x, y:p.y, rotation:p.rotation};
    if (collision(board, active)) return null;
    const number = (name, fallback, minimum) => Number.isFinite(input[name]) ? Math.max(minimum, input[name]) : fallback;
    const level = Math.min(99, number('level', 1, 1)), lines = number('lines', 0, 0);
    return {
      board, active, mode, queue: (Array.isArray(input.queue) ? input.queue : []).slice(0, mode === 'classic' ? 1 : 5).filter(v => TYPES.includes(v)),
      holdType: TYPES.includes(input.holdType) ? input.holdType : null,
      canHold: mode !== 'classic' && input.canHold !== false,
      score:number('score',0,0), lines, level, combo:number('combo',-1,-1), b2b:Boolean(input.b2b),
      b2bCount:0, pieces:0, tetrises:0, tspins:0, status:'running',
      lastAction:['move','rotate','drop'].includes(input.lastAction) ? input.lastAction : null,
      lastKick:Number.isInteger(input.lastKick) ? input.lastKick : -1,
      startLevel:Math.max(1, level - Math.floor(lines / 10))
    };
  }
  // Engine rotations and movement are the authoritative SRS/classic rules.
  // A facade avoids constructing games, generating pieces or saving history.
  function facade(state) {
    const game = Object.create(Game.prototype);
    game.state = state;
    game.config = {startLevel:state.startLevel || 1, lockDelay:500};
    game._emit = game._resetLock = () => {};
    game._grounded = () => false;
    game._spawn = () => { game.state.active = null; };
    game._turnStart = null;
    return game;
  }
  function movementGame(view) {
    return facade({...view, active:{...view.active}, status:'running', lockResets:0, lockMs:0, fallMs:0});
  }
  function action(game, name) {
    if (name === 'left') return game.move(-1);
    if (name === 'right') return game.move(1);
    if (name === 'cw') return game.rotate(1);
    if (name === 'ccw') return game.rotate(-1);
    if (name === 'soft') return game.softDrop();
    return false;
  }
  function context(options) {
    const now = typeof options.now === 'function' ? options.now : clock;
    const start = now();
    const budgetMs = Number.isFinite(options.budgetMs) ? Math.max(0, Math.min(2000, options.budgetMs)) : 70;
    const maxNodes = Number.isInteger(options.maxNodes) ? Math.max(1, options.maxNodes) : 150000;
    return {now, start, deadline:start+budgetMs, nodes:0, maxNodes, cut:false,
      expired() { const expired = this.nodes >= this.maxNodes || this.now() >= this.deadline; if (expired) this.cut = true; return expired; }};
  }
  function reconstruct(nodes, index) {
    const path = [];
    for (let node = nodes[index]; node && node.parent !== -1; node = nodes[node.parent]) path.push(node.action);
    return path.reverse();
  }
  function stateKey(node, type) {
    // For T, preserve the last-rotation flag and fifth-kick classification:
    // these affect genuine T-spin scoring at an otherwise identical position.
    return node.x + ',' + node.y + ',' + node.rotation + (type === 'T' ? ',' + (node.lastAction === 'rotate' ? (node.lastKick === 4 ? 2 : 1) : 0) : '');
  }
  function enumerate(view, ctx) {
    const game = movementGame(view), type = view.active.type;
    const first = {...view.active, lastAction:view.lastAction, lastKick:view.lastKick, parent:-1, length:0};
    const nodes = [first], seen = new Set([stateKey(first,type)]), goals = new Map(), dropCache = new Map();
    let cursor = 0;
    function landing(node) {
      const prefix = node.x + ',' + node.rotation + ',';
      const key = prefix + node.y;
      if (dropCache.has(key)) return dropCache.get(key);
      const piece = {type,x:node.x,y:node.y,rotation:node.rotation};
      let bottom = node.y;
      while (!collision(view.board, {...piece,y:bottom+1})) bottom++;
      for (let y=node.y; y<=bottom; y++) dropCache.set(prefix+y,bottom);
      return bottom;
    }
    function goal(node, index) {
      const y = landing(node), piece = {type,x:node.x,y,rotation:node.rotation};
      const lastAction = y === node.y ? node.lastAction : 'drop';
      const lastKick = y === node.y ? node.lastKick : -1;
      game.state.active = piece; game.state.lastAction = lastAction; game.state.lastKick = lastKick;
      const spin = game._tSpin();
      const key = cells(piece).map(c => c.x + ':' + c.y).sort().join(',') + ':' + (spin || '');
      const prior = goals.get(key);
      if (!prior || node.length < prior.length) goals.set(key, {piece, lastAction, lastKick, spin, length:node.length, index});
    }
    // Always preserve a legal immediate drop, even when the budget is zero.
    goal(first,0);
    while (cursor < nodes.length) {
      if ((cursor & 31) === 0 && ctx.expired()) break;
      const node = nodes[cursor], index = cursor++;
      ctx.nodes++;
      goal(node,index);
      for (const name of ['left','right','cw','ccw','soft']) {
        game.state.active = {type,x:node.x,y:node.y,rotation:node.rotation};
        game.state.lastAction = node.lastAction; game.state.lastKick = node.lastKick;
        if (!action(game,name)) continue;
        const next = {...game.state.active, lastAction:game.state.lastAction,lastKick:game.state.lastKick,parent:index,action:name,length:node.length+1};
        const key = stateKey(next,type);
        if (!seen.has(key)) { seen.add(key); nodes.push(next); }
      }
    }
    return {complete:cursor === nodes.length, placements:[...goals.values()].map(item => ({...item,path:[...reconstruct(nodes,item.index),'hard']}))};
  }
  function heldView(view) {
    if (!view.canHold || view.mode === 'classic') return null;
    const queue = view.queue.slice(), type = view.holdType || queue.shift();
    if (!type) return null;
    const active = spawn(type);
    if (collision(view.board,active)) return null;
    return {...view, active, queue, holdType:view.active.type, canHold:false,lastAction:null,lastKick:-1};
  }
  function inspect(board) {
    const heights = [], holesByColumn = [], covered = [];
    const rowMasks=Array(ROWS).fill(0);
    let holes = 0, coveredDepth = 0, aggregateHeight = 0, maxHeight = 0, bumpiness = 0, rowTransitions = 0;
    for (let x=0;x<COLS;x++) {
      let top = ROWS, blocks = 0, columnHoles = 0;
      for (let y=0;y<ROWS;y++) {
        if (board[y][x] !== null) { if (top === ROWS) top=y; blocks++; rowMasks[y]|=1<<x; }
        else if (top !== ROWS) { holes++; columnHoles++; coveredDepth += blocks; }
      }
      const height = ROWS-top;
      heights.push(height); holesByColumn.push(columnHoles); covered.push(blocks);
      aggregateHeight += height; maxHeight = Math.max(maxHeight,height);
      if (x) bumpiness += Math.abs(height-heights[x-1]);
    }
    for (let y=HIDDEN_ROWS;y<ROWS;y++) {
      let previous = true;
      for (let x=0;x<COLS;x++) { const occupied=board[y][x] !== null; if (previous !== occupied) rowTransitions++; previous=occupied; }
      if (!previous) rowTransitions++;
    }
    let wellDepth = 0, deepWells = 0;
    const wells = [];
    for (let x=0;x<COLS;x++) {
      const depth = Math.max(0,Math.min(x ? heights[x-1] : ROWS,x < COLS-1 ? heights[x+1] : ROWS)-heights[x]);
      wellDepth = Math.max(wellDepth,depth); deepWells += Math.max(0,depth-5);
      if (!depth || holesByColumn[x]) continue;
      let ready = 0, nearlyReady = 0;
      // Credit only the open, vertically accessible part of a well. A buried
      // hole is never a banked Tetris, even if its row has nine filled cells.
      for (let y=ROWS-heights[x]-1;y>=ROWS-heights[x]-Math.min(depth,6);y--) {
        let filled=0;
        for (let xx=0;xx<COLS;xx++) if (xx !== x && board[y][xx] !== null) filled++;
        if (filled === COLS-1) ready++;
        else if (filled === COLS-2) nearlyReady++;
      }
      wells.push({x,depth,ready,nearlyReady,edge:x === 0 || x === COLS-1});
    }
    return {heights,holes,holesByColumn,coveredDepth,aggregateHeight,maxHeight,bumpiness,wellDepth,deepWells,rowTransitions,wells,rowMasks};
  }
  function strategicSafety(m) {
    return Math.max(0,Math.min(1,(13-m.maxHeight)/5)) / (1+m.holes*3);
  }
  function choosePolicy(m,mode) {
    // Keep a real central setup, but do not mistake a one-row dent for a
    // long-term central well. Otherwise choose one edge for this whole search.
    const established=m.wells.filter(well=>well.ready>=2 || (well.depth>=3&&well.ready>=1))
      .sort((a,b)=>(b.ready*8+Math.min(5,b.depth)+(b.edge?2:0))-(a.ready*8+Math.min(5,a.depth)+(a.edge?2:0)));
    let column;
    if(established.length)column=established[0].x;
    else {
      const cost=x=>m.heights[x]*3+m.holesByColumn[x]*12-Math.max(0,m.heights[x===0?1:COLS-2]-m.heights[x])*2;
      column=cost(0)<cost(COLS-1)?0:COLS-1;
    }
    return {wellColumn:column,style:mode==='sprint'?0.35:mode==='classic'?0.8:1};
  }
  function bankMetrics(m,policy) {
    if(!Number.isInteger(policy.wellColumn))return {column:null,ready:0,cells:0,value:0,safety:0};
    const column=policy.wellColumn,base=m.heights[column],safety=strategicSafety(m)*policy.style;
    let filled=0,ready=0,value=0;
    // Reward progress in the other nine columns before any row is complete.
    // This offsets safe banked-cell height cost; it does not value an unscored
    // four-row bank above actually cashing the Tetris and clearing its height.
    for(let offset=1;offset<=4 && base+offset<=ROWS;offset++) {
      let mask=m.rowMasks[ROWS-base-offset]&~(1<<column),count=0;
      while(mask){mask&=mask-1;count++;}
      filled+=count;if(count===COLS-1)ready++;
      value+=count+13*Math.pow(count/(COLS-1),2);
    }
    return {column,ready,cells:filled,value:(value+(ready>=4?6:0))*safety,safety};
  }
  function boardValue(m,view,policy) {
    const danger = Math.max(0,m.maxHeight-14);
    const bank=bankMetrics(m,policy),well=m.wells.find(item=>item.x===policy.wellColumn);
    const wellShape=well ? (Math.min(m.bumpiness,well.depth*(well.edge?1:2))*2.5+Math.min(4,well.depth)*1.2)*bank.safety : 0;
    const heldI=view.mode!=='classic'&&view.holdType==='I' ? 12*bank.safety : 0;
    // At high stacks, clearing space dominates speculative scoring setups.
    const heightWeight=1.15+Math.max(0,m.maxHeight-9)*0.5;
    const chain=view.mode !== 'classic' && view.b2b ? 11*Math.max(0,(18-m.maxHeight)/18) : 0;
    return -m.holes*68 -m.coveredDepth*3.8 -m.aggregateHeight*heightWeight -m.bumpiness*2.5
      -m.deepWells*4 -danger*danger*18 -m.rowTransitions*0.35 +bank.value+wellShape+heldI+chain;
  }
  function lock(view,placement) {
    const state = {...view, board:copyBoard(view.board), active:{...placement.piece},queue:view.queue.slice(),
      lastAction:placement.lastAction,lastKick:placement.lastKick,status:'running',lockResets:0,lockMs:0,fallMs:0};
    const game = facade(state);
    // Use the engine's lock/scoring implementation, without its spawning RNG.
    game._lock();
    const clear = {...state.lastClear};
    const lost = state.status === 'over';
    const won = state.status === 'won';
    if (!lost && !won && state.queue.length) {
      state.active = spawn(state.queue.shift());
      state.lastAction = null; state.lastKick = -1;
      if (collision(state.board,state.active)) { state.active=null; state.status='over'; }
    }
    return {state,clear,lost:state.status === 'over',won};
  }
  function reward(clear,view) {
    // Read actual engine scoring, including full/mini spins, B2B, combos and
    // perfect clears. Normalize level so a high level cannot buy fatal holes.
    // A no-line spin changes neither terrain nor B2B. Its real game points
    // remain intact, but are not a tactical reason to descend slowly and
    // rotate gratuitously when the same placement can be dropped directly.
    if(clear.lines===0)return 0;
    const points=clear.points/view.level;
    if (view.mode === 'sprint') return clear.lines*31 + points*0.018;
    return points*(view.mode === 'ultra' ? 0.075 : 0.065) +clear.lines*6;
  }
  function operationCost(move) {
    // Automatic actions take roughly 55 ms each. Price the whole continuation,
    // not just its first placement; repeated soft drops deserve a meaningful
    // cost while genuine spins/tucks can still repay it by score or terrain.
    return move.path.reduce((cost,step)=>cost+(step==='soft'?0.5:step==='hard'?0.1:0.25),0);
  }
  function candidates(view,ctx,policy,keepSpinVariants=false) {
    policy=policy || choosePolicy(inspect(view.board),view.mode);
    const before=inspect(view.board),beforeBank=bankMetrics(before,policy);
    const result = [];
    let complete = true;
    // Give both direct and hold branches a legal fallback before deep work.
    const branches = [{view,hold:false}];
    const held = heldView(view); if (held) branches.push({view:held,hold:true});
    for (const branch of branches) {
      const search = enumerate(branch.view,ctx);
      complete = complete && search.complete;
      for (const placement of search.placements) {
        const outcome=lock(branch.view,placement), metrics=inspect(outcome.state.board),bank=bankMetrics(metrics,policy);
        const move={piece:{...placement.piece},cells:cells(placement.piece),origin:{...branch.view.active},hold:branch.hold,path:branch.hold ? ['hold',...placement.path] : placement.path};
        // An ordinary small clear that spends a safe bank has an opportunity
        // cost. Spins, perfect clears, repaired holes and dangerous stacks are
        // evaluated for their actual score/space instead of paying this cost.
        const spendsBank=outcome.clear.lines>0&&outcome.clear.lines<4&&!outcome.clear.spin&&!outcome.clear.perfect&&
          metrics.holes>=before.holes&&beforeBank.cells>bank.cells;
        const bankSpent=spendsBank ? Math.min(beforeBank.value,12*outcome.clear.lines*beforeBank.safety) : 0;
        const newHoles=Math.max(0,metrics.holes-before.holes)*10*beforeBank.safety;
        const adjustment=-bankSpent-newHoles+(outcome.clear.lines===4?8*beforeBank.safety:0);
        metrics.bank={column:bank.column,ready:bank.ready,cells:bank.cells,safety:bank.safety,heldI:outcome.state.holdType==='I',adjustment};
        result.push({state:outcome.state,clear:outcome.clear,metrics,move,effort:operationCost(move),
          reward:reward(outcome.clear,view),adjustment,
          value:boardValue(metrics,outcome.state,policy)+(outcome.lost ? -100000 : 0)+(outcome.won ? 100000 : 0),
          lost:outcome.lost,won:outcome.won});
      }
    }
    if(keepSpinVariants)return {items:result,complete};
    const items=[],equivalentPlacements=new Map();
    for(const item of result) {
      const p=item.move.piece,key=[item.move.hold,p.type,p.x,p.y,p.rotation].join(':');
      if(!equivalentPlacements.has(key))equivalentPlacements.set(key,[]);
      equivalentPlacements.get(key).push(item);
    }
    const cheapest=variants=>variants.reduce((prior,item)=>!prior||item.effort<prior.effort||
      (item.effort===prior.effort&&item.clear.points>prior.clear.points)?item:prior,null);
    for(const variants of equivalentPlacements.values()) {
      // Prefer a direct rotation/shift + hard drop whenever it reaches these
      // same cells. Wall corners can award a Mini Single after a long soft
      // descent even though no tuck is needed; its score or B2B label should
      // not buy a gratuitous detour to an otherwise identical placement.
      // Genuine spins/tucks without direct access retain their scored routes.
      const direct=variants.filter(item=>!item.move.path.includes('soft'));
      if(direct.length){items.push(cheapest(direct));continue;}
      // With no clear, last-rotation labels change neither terrain nor B2B.
      // Keep one efficient access path instead of several score-only labels.
      if(!variants[0].clear.lines)items.push(cheapest(variants));
      else items.push(...variants);
    }
    return {items,complete};
  }
  function describe(before,best,depth) {
    const clear=best.clear, after=best.metrics, parts=[];
    if (best.move.hold) parts.push('先暂存换块');
    if (clear.perfect) parts.push('争取全消');
    else if (clear.spin && clear.lines) parts.push('完成 T-Spin，消除 '+clear.lines+' 行');
    else if (clear.lines === 4) parts.push('消除四行');
    else if (clear.lines) parts.push('消除 '+clear.lines+' 行');
    if (after.holes < before.holes) parts.push('减少 '+(before.holes-after.holes)+' 个空洞');
    else if (after.holes > before.holes) parts.push('会新增 '+(after.holes-before.holes)+' 个空洞'+(depth>1?'，结合后续预览权衡':''));
    else if (!after.holes) parts.push('保持无空洞');
    else parts.push('避免新增空洞');
    if (after.maxHeight < before.maxHeight) parts.push('降低堆高');
    else if (after.bumpiness < before.bumpiness) parts.push('让表面更平整');
    if (!parts.length) parts.push('保持后续落子空间');
    return parts.join('，')+'。';
  }
  function analyze(input,options) {
    options=options || {};
    const ctx=context(options), view=publicView(input);
    if (!view) return {move:null,reason:'当前没有可分析的方块。',metrics:null,depth:0,nodes:0,elapsedMs:Math.max(0,ctx.now()-ctx.start),knownOnly:true};
    const maxDepth=Math.max(1,Math.min(6,Number.isInteger(options.maxDepth) ? options.maxDepth : 5));
    const beamWidth=Math.max(1,Math.min(16,Number.isInteger(options.beamWidth) ? options.beamWidth : 5));
    const before=inspect(view.board);
    const policy=choosePolicy(before,view.mode);
    const root=candidates(view,ctx,policy);
    const compare=(a,b) => b.total-a.total || a.root.move.path.length-b.root.move.path.length || a.order-b.order;
    let order=0;
    function beam(items) {
      items.sort(compare);
      const kept=[],counts=new Map(),limit=Math.max(1,Math.ceil(beamWidth/3));
      // Keep several genuinely different first placements alive. A family of
      // descendants after an immediate single must not evict every bank plan.
      for(const item of items) {
        const count=counts.get(item.root)||0;
        if(count>=limit)continue;
        kept.push(item);counts.set(item.root,count+1);
        if(kept.length===beamWidth)return kept;
      }
      for(const item of items)if(!kept.includes(item)){kept.push(item);if(kept.length===beamWidth)break;}
      return kept;
    }
    let frontier=root.items.map(item => ({...item,root:item,accumulated:item.reward+item.adjustment-item.effort,total:item.value+item.reward+item.adjustment-item.effort,order:order++})).sort(compare);
    let best=frontier[0],depth=1;
    frontier=beam(frontier);
    // Only adopt a deeper horizon once the complete beam has been expanded.
    // A deadline therefore never mixes short and long horizon scores.
    for (let d=2;d<=maxDepth && root.complete && !ctx.expired();d++) {
      const next=[]; let complete=true,expanded=false;
      for (const parent of frontier) {
        if (!parent.state.active || parent.lost || parent.won) { next.push(parent); continue; }
        if (ctx.expired()) {complete=false;break;}
        const expansion=candidates(parent.state,ctx,policy);
        if (!expansion.complete) {complete=false;break;}
        expanded=true;
        for (const item of expansion.items) {
          const accumulated=parent.accumulated+(item.reward+item.adjustment-item.effort)*Math.pow(0.985,d-1);
          next.push({...item,root:parent.root,accumulated,total:item.value+accumulated,order:order++});
        }
      }
      if (!complete || !expanded || !next.length) break;
      frontier=beam(next);best=frontier[0];depth=d;
    }
    const chosen=best.root;
    return {move:chosen.move,reason:chosen.lost ? '当前可见搜索未找到安全落点，请考虑撤销调整。' : describe(before,chosen,depth),metrics:{...chosen.metrics,holesBefore:before.holes,maxHeightBefore:before.maxHeight,topOut:chosen.lost,
      lines:chosen.clear.lines,spin:chosen.clear.spin,perfect:chosen.clear.perfect,points:chosen.clear.points,scoreReward:chosen.reward,operationCost:chosen.effort,estimatedActionMs:chosen.move.path.length*55,b2b:chosen.clear.b2b,value:best.total},
      depth,nodes:ctx.nodes,elapsedMs:Math.max(0,ctx.now()-ctx.start),visiblePieces:view.queue.length,knownOnly:true,
      rootComplete:root.complete,budgetLimited:ctx.cut,candidates:root.items.length};
  }
  function applyPath(input,move) {
    const view=publicView(input);
    if (!view || !move || !Array.isArray(move.path)) return {valid:false};
    let state=view, game=movementGame(state), usedHold=false;
    for (let i=0;i<move.path.length;i++) {
      const name=move.path[i];
      if (name === 'hold') {
        if (i !== 0 || usedHold) return {valid:false};
        state=heldView(game.state); if (!state) return {valid:false};
        game=movementGame(state);usedHold=true;
      } else if (name === 'hard') {
        if (i !== move.path.length-1) return {valid:false};
        const y=E.ghostY(game.state),distance=y-game.state.active.y;
        const piece={...game.state.active,y};
        const placement={piece,lastAction:distance ? 'drop' : game.state.lastAction,lastKick:distance ? -1 : game.state.lastKick};
        const outcome=lock(game.state,placement);
        return {valid:usedHold === Boolean(move.hold) && Boolean(move.piece) && ['type','x','y','rotation'].every(key => piece[key] === move.piece[key]),piece,cells:cells(piece),board:outcome.state.board,clear:outcome.clear,status:outcome.state.status};
      } else if (!action(game,name)) return {valid:false};
    }
    return {valid:false};
  }
  // Re-route to an already chosen placement. This intentionally has no board
  // evaluation and cannot pick a different target while the player moves.
  function routeTo(input,move,options) {
    options=options || {};
    const view=publicView(input), target=move && move.piece;
    if (!view || !target || !TYPES.includes(target.type) || !['x','y','rotation'].every(key=>Number.isInteger(target[key])) ||
      target.rotation<0 || target.rotation>3 || collision(view.board,target) || !collision(view.board,{...target,y:target.y+1})) return null;
    const hold=Boolean(move.hold), start=hold ? heldView(view) : view;
    if (!start || start.active.type !== target.type) return null;
    const expectedSpin=options.spin || null;
    const output=path=>({piece:{type:target.type,x:target.x,y:target.y,rotation:target.rotation},cells:cells(target),hold,path:hold ? ['hold',...path] : path});
    function matches(game) {
      const piece=game.state.active;
      if (piece.x !== target.x || piece.rotation !== target.rotation) return false;
      let y=piece.y;
      while (!collision(start.board,{...piece,y:y+1})) y++;
      if (y !== target.y) return false;
      if (!expectedSpin) return true;
      const lastAction=game.state.lastAction,lastKick=game.state.lastKick;
      game.state.active={...piece,y};
      if (y !== piece.y) {game.state.lastAction='drop';game.state.lastKick=-1;}
      const spin=game._tSpin();
      game.state.active=piece;game.state.lastAction=lastAction;game.state.lastKick=lastKick;
      return spin === expectedSpin;
    }
    function tryPath(path) {
      const game=movementGame(start),performed=[];
      for (const name of path) {
        if (action(game,name)) performed.push(name);
        else if (name !== 'soft') return null;
      }
      return matches(game) ? output([...performed,'hard']) : null;
    }
    const difference=(target.rotation-start.active.rotation+4)%4;
    const rotations=difference === 0 ? [[]] : difference === 1 ? [['cw']] : difference === 3 ? [['ccw']] : [['cw','cw'],['ccw','ccw']];
    const shift=delta=>Array.from({length:Math.abs(delta)},()=>delta<0 ? 'left' : 'right');
    let direct=null;
    function consider(candidate){if(candidate&&(!direct||operationCost(candidate)<operationCost(direct)))direct=candidate;}
    // Prefer verified direct drops before replaying a cached soft-drop route.
    // A promised scoring spin is still required by matches(), so this cannot
    // turn a genuine T-Spin recommendation into an ordinary lock.
    for (const rotation of rotations) {
      consider(tryPath([...shift(target.x-start.active.x),...rotation]));
      const game=movementGame(start);
      if(rotation.every(name=>action(game,name)))consider(tryPath([...rotation,...shift(target.x-game.state.active.x)]));
    }
    if(direct)return direct;
    const prior=Array.isArray(move.path) ? move.path.filter(name=>name !== 'hold' && name !== 'hard') : [];
    // Most movement only changes one axis. These attempts complete in a few
    // engine operations, keeping the common UI path outside the BFS budget.
    if (prior.length<=128) {
      const found=tryPath(prior);if(found)return found;
      // Reuse a planned tuck after the player nudges sideways or gravity has
      // already performed part of its descent. Every retained action is still
      // replayed through SRS before accepting the unchanged target and spin.
      for (const delta of [-1,1,-2,2]) {
        const adjusted=tryPath([...Array.from({length:Math.abs(delta)},()=>delta<0 ? 'left' : 'right'),...prior]);
        if (adjusted) return adjusted;
      }
      if (move.origin && move.origin.type === target.type && Number.isInteger(move.origin.x) && Math.abs(move.origin.x)<COLS &&
        Number.isInteger(move.origin.rotation) && move.origin.rotation>=0 && move.origin.rotation<=3) {
        const undoRotation=(move.origin.rotation-start.active.rotation+4)%4;
        const prefix=undoRotation === 1 ? ['cw'] : undoRotation === 3 ? ['ccw'] : undoRotation === 2 ? ['cw','cw'] : [];
        const game=movementGame(start);
        if (prefix.every(name=>action(game,name))) {
          const delta=move.origin.x-game.state.active.x;
          const restored=tryPath([...prefix,...Array.from({length:Math.abs(delta)},()=>delta<0 ? 'left' : 'right'),...prior]);
          if (restored) return restored;
        }
      }
    }
    const ctx=context({...options,budgetMs:Number.isFinite(options.budgetMs) ? options.budgetMs : 4,maxNodes:Number.isInteger(options.maxNodes) ? options.maxNodes : 384});
    const game=movementGame(start), type=start.active.type;
    const first={...start.active,lastAction:start.lastAction,lastKick:start.lastKick,parent:-1};
    const nodes=[first], seen=new Set([stateKey(first,type)]);
    let cursor=0;
    while (cursor<nodes.length) {
      if ((cursor & 7) === 0 && ctx.expired()) return null;
      const node=nodes[cursor],index=cursor++;
      ctx.nodes++;
      game.state.active={type,x:node.x,y:node.y,rotation:node.rotation};
      game.state.lastAction=node.lastAction;game.state.lastKick=node.lastKick;
      if (matches(game)) return output([...reconstruct(nodes,index),'hard']);
      for (const name of ['left','right','cw','ccw','soft']) {
        game.state.active={type,x:node.x,y:node.y,rotation:node.rotation};
        game.state.lastAction=node.lastAction;game.state.lastKick=node.lastKick;
        if (!action(game,name)) continue;
        const next={...game.state.active,lastAction:game.state.lastAction,lastKick:game.state.lastKick,parent:index,action:name};
        const key=stateKey(next,type);
        if (!seen.has(key)) {seen.add(key);nodes.push(next);}
      }
    }
    return null;
  }
  function enumeratePlacements(input,options) {
    const view=publicView(input);if (!view) return [];
    return candidates(view,context(options || {budgetMs:2000}),undefined,true).items.map(item => ({move:item.move,metrics:item.metrics,clear:item.clear}));
  }
  return {analyze,applyPath,routeTo,enumeratePlacements,inspect};
});
