'use strict';
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const E=require('../engine.js');

function loadCoach(filename){
  filename=path.resolve(filename);
  const source=fs.readFileSync(filename,'utf8').replace(/require\('\.\/engine\.js'\)/g,'require('+JSON.stringify(require.resolve('../engine.js'))+')');
  const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(source,filename);return loaded.exports;
}
function publicView(state){
  return {mode:state.mode,board:state.board.map(row=>row.slice()),active:{...state.active},
    queue:state.queue.slice(0,state.mode==='classic'?1:5),holdType:state.holdType,canHold:state.canHold,
    score:state.score,lines:state.lines,level:state.level,combo:state.combo,b2b:state.b2b,
    lastAction:state.lastAction,lastKick:state.lastKick};
}
function apply(game,move){
  for(const step of move.path){
    let result;
    if(step==='hold')result=game.hold();else if(step==='hard')result=game.hardDrop();
    else if(step==='soft')result=game.softDrop();else if(step==='cw'||step==='ccw')result=game.rotate(step==='cw'?1:-1);
    else result=game.move(step==='left'?-1:1);
    if(result===false)throw Error('Invalid recommended '+step);
  }
  game.drainEvents();
}
function runGame(C,seed,limit,options,cases=[]){
  const game=new E.Game({mode:'marathon',seed});game.start();game.drainEvents();
  const stats={seed,requestedPieces:limit,pieces:0,lines:0,score:0,tetrises:0,singles:0,doubles:0,triples:0,spins:0,perfects:0,
    edgeWellTurns:0,bankedEdgeTurns:0,earlyEdgeWellTurns:0,rootIncomplete:0,depths:{},meanHoles:0,maxHoles:0,maxHeight:0,totalMs:0,totalWallMs:0};
  for(let turn=0;turn<limit&&game.state.status==='running';turn++){
    const view=publicView(game.state),before=C.inspect(view.board),wallStart=performance.now(),result=C.analyze(view,options);
    stats.totalWallMs+=performance.now()-wallStart;
    if(!result.move||!C.applyPath(view,result.move).valid)throw Error('Unsafe recommendation at seed '+seed+' turn '+turn);
    stats.depths[result.depth]=(stats.depths[result.depth]||0)+1;stats.rootIncomplete+=!result.rootComplete;stats.totalMs+=result.elapsedMs;
    const safe=before.holes===0&&before.maxHeight<=9;
    const edge=before.wells.filter(well=>well.edge&&well.ready>=1&&well.depth>=1).sort((a,b)=>b.ready-a.ready)[0];
    if(cases.length<10&&safe&&edge&&result.metrics.lines>0&&result.metrics.lines<4&&!result.metrics.perfect&&!result.metrics.spin){
      const alternatives=C.enumeratePlacements(view,{now:()=>0,budgetMs:1,maxDepth:1});
      const bank=alternatives.filter(item=>item.clear.lines===0&&item.metrics.holes===0&&item.metrics.maxHeight<=before.maxHeight+2&&
        item.metrics.wells.some(well=>well.x===edge.x&&well.ready>=edge.ready)).sort((a,b)=>b.metrics.wells.find(well=>well.x===edge.x).ready-a.metrics.wells.find(well=>well.x===edge.x).ready)[0];
      if(bank&&!cases.some(item=>item.seed===seed&&item.turn===turn))cases.push({seed,turn,kind:'safe-clear-with-bank-alternative',view,before,recommendation:result,bankAlternative:bank});
    }
    apply(game,result.move);
    const clear=game.state.lastClear,after=C.inspect(game.state.board);
    if(clear.lines===1)stats.singles++;else if(clear.lines===2)stats.doubles++;else if(clear.lines===3)stats.triples++;else if(clear.lines===4)stats.tetrises++;
    stats.spins+=!!clear.spin;stats.perfects+=clear.perfect;
    const openEdge=after.wells.some(well=>well.edge&&well.depth>=2&&well.ready>=1);
    stats.edgeWellTurns+=openEdge;stats.bankedEdgeTurns+=after.wells.some(well=>well.edge&&well.ready>=3);
    if(turn<40)stats.earlyEdgeWellTurns+=openEdge;
    stats.meanHoles+=after.holes;stats.maxHoles=Math.max(stats.maxHoles,after.holes);stats.maxHeight=Math.max(stats.maxHeight,after.maxHeight);
    stats.pieces=game.state.pieces;
  }
  stats.lines=game.state.lines;stats.score=game.state.score;stats.status=game.state.status;
  stats.meanHoles=+(stats.meanHoles/Math.max(1,stats.pieces)).toFixed(2);
  stats.meanMs=+(stats.totalMs/Math.max(1,stats.pieces)).toFixed(2);delete stats.totalMs;
  stats.meanWallMs=+(stats.totalWallMs/Math.max(1,stats.pieces)).toFixed(2);delete stats.totalWallMs;
  stats.edgeWellRatio=+(stats.edgeWellTurns/Math.max(1,stats.pieces)).toFixed(3);
  stats.tetrisLineShare=+(4*stats.tetrises/Math.max(1,stats.lines)).toFixed(3);
  return stats;
}
function main(){
  const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const index=arg.indexOf('=');return [arg.slice(2,index<0?undefined:index),index<0?true:arg.slice(index+1)];}));
  const filename=path.resolve(args.coach||path.join(__dirname,'..','coach.js')),C=loadCoach(filename);
  const seeds=(args.seeds||'1,7,42').split(',').map(Number),pieces=Number(args.pieces||120),kind=args.kind||'runtime';
  const options=kind==='runtime'?{budgetMs:85,maxDepth:6,beamWidth:5}:{now:()=>0,budgetMs:1,maxDepth:6,beamWidth:5,maxNodes:Number(args.nodes||12000)};
  const cases=[],runs=[];
  for(const seed of seeds){const result=runGame(C,seed,pieces,options,cases);runs.push(result);process.stderr.write(JSON.stringify(result)+'\n');}
  const output={coach:filename,kind,pieces,seeds,options:{budgetMs:options.budgetMs,maxDepth:options.maxDepth,beamWidth:options.beamWidth,maxNodes:options.maxNodes},runs,cases};
  if(args.out)fs.writeFileSync(path.resolve(args.out),JSON.stringify(output,null,2)+'\n');
  process.stdout.write(JSON.stringify({coach:filename,kind,runs,cases:cases.length},null,2)+'\n');
}
if(require.main===module)main();
module.exports={loadCoach,publicView,apply,runGame};
