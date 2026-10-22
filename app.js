/* Local-first UI. No network requests, analytics, or external runtime dependencies. */
(() => {
  'use strict';
  const E = window.PixelEngine;
  const A = window.PixelAudio;
  const C = window.PixelCoachCore;
  const soundEngine = new A.SoundEngine({enabled:false});
  const PIXEL_COLORS = {I:'#41d9ed',O:'#f5cf4b',T:'#ba82fa',S:'#8fdb58',Z:'#f3657c',J:'#668bfa',L:'#f6a24d'};
  const elements = new Map();
  const $ = selector => {
    // IDs are stable for the lifetime of this page; dynamic lists still query live.
    if(!/^#[\w-]+$/.test(selector))return document.querySelector(selector);
    if(!elements.has(selector))elements.set(selector,document.querySelector(selector));
    return elements.get(selector);
  };
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const STORAGE_KEY = 'pixelstack.local.v1';
  const MODES = {
    marathon: {name:'马拉松', en:'MARATHON', icon:'▟', description:'不设终点。每消除 10 行，速度提升一级。'},
    sprint: {name:'40 行竞速', en:'40-LINE SPRINT', icon:'ϟ', description:'消除 40 行，和自己的最快纪录赛跑。'},
    ultra: {name:'两分钟', en:'120s ULTRA', icon:'◷', description:'只有两分钟。把每一次消除，都变成分数。'},
    zen: {name:'禅模式', en:'ZEN / NO GRAVITY', icon:'✳', description:'没有自动下落。慢慢想，按空格放好这一块。'},
    classic: {name:'复古模式', en:'RETRO CLASSIC', icon:'▦', description:'经典启发规则：无暂存、无影子、单块预览。'}
  };
  const ACTIONS = {left:'向左移动',right:'向右移动',rotate:'顺时针旋转',ccw:'逆时针旋转',half:'旋转 180°',soft:'软降',hard:'硬降 / 直接落下',hold:'暂存 / 交换',undo:'撤销上一次落子',coach:'AI 提示 / 自动'};
  const hasMode = value => typeof value==='string' && Object.hasOwn(MODES,value);
  const DEFAULT_KEYS = {left:'ArrowLeft',right:'ArrowRight',rotate:'ArrowUp',ccw:'KeyZ',half:'KeyA',soft:'ArrowDown',hard:'Space',hold:'KeyC',undo:'KeyU',coach:'KeyG'};
  const DEFAULTS = {startLevel:1,das:150,arr:35,softInterval:35,lockDelay:500,ghost:true,grid:true,sound:false,coach:false,audio:A.normalizeConfig(),theme:'paper',lastMode:'marathon',keys:{...DEFAULT_KEYS}};
  const RANGES = {startLevel:[1,20],das:[50,500],arr:[0,150],softInterval:[10,150],lockDelay:[100,1000]};
  const RESERVED = new Set(['Escape','KeyP','Enter','NumpadEnter','KeyF','KeyR','Tab','CapsLock','ContextMenu']);
  const isBindable = code => typeof code === 'string' && /^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Space|Shift(Left|Right)|Bracket(Left|Right)|Comma|Period|Slash|Semicolon|Quote|Backslash|Minus|Equal|Backquote)$/.test(code) && !RESERVED.has(code);
  const clone = obj => JSON.parse(JSON.stringify(obj));
  const id = () => window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const formatTime = (ms,precise=false) => { const sec=Math.max(0,ms)/1000; return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(Math.floor(sec%60)).padStart(2,'0')}${precise?'.'+String(Math.floor(sec%1*100)).padStart(2,'0'):''}`; };
  const number = n => Math.round(n).toLocaleString('en-US');
  function keyName(code) {
    return {ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓',Space:'空格',ShiftLeft:'左 Shift',ShiftRight:'右 Shift'}[code] || code.replace(/^Key|^Digit/,'');
  }
  function cleanSettings(input,strict=false) {
    if (!input || typeof input!=='object' || Array.isArray(input)) { if(strict) throw Error('设置格式不正确'); return clone(DEFAULTS); }
    const result=clone(DEFAULTS);
    for(const [name,[min,max]] of Object.entries(RANGES)) {
      const val=input[name];
      if(Number.isInteger(val)&&val>=min&&val<=max) result[name]=val;
      else if(strict) throw Error('设置参数超出范围：'+name);
    }
    for(const name of ['ghost','grid','sound']) { if(typeof input[name]==='boolean')result[name]=input[name]; else if(strict)throw Error('设置格式不正确'); }
    if(typeof input.coach==='boolean')result.coach=input.coach;else if(input.coach!==undefined&&strict)throw Error('教练设置不正确');
    result.audio=A.normalizeConfig(input.audio);
    if(['paper','night','mint'].includes(input.theme))result.theme=input.theme; else if(strict)throw Error('配色不正确');
    // Retired course mode must not prevent older backups from restoring.
    if(input.lastMode==='training')result.lastMode='marathon';
    else if(hasMode(input.lastMode))result.lastMode=input.lastMode;else if(strict)throw Error('游戏模式无效');
    const used=new Set();
    for(const action of Object.keys(ACTIONS)) {
      // New actions must not steal a key already chosen in an older backup.
      const existing=new Set(Object.entries(input.keys||{}).filter(([name])=>name!==action).map(([,key])=>key));
      const key=input.keys?.[action] ?? (['undo','coach'].includes(action)?[DEFAULT_KEYS[action],...Array.from({length:26},(_,index)=>'Key'+String.fromCharCode(65+index))].find(candidate=>isBindable(candidate)&&!used.has(candidate)&&!existing.has(candidate)):undefined);
      if(isBindable(key)&&!used.has(key)){result.keys[action]=key;used.add(key);}
      else if(strict)throw Error('按键设置无效或重复');
    }
    if(new Set(Object.values(result.keys)).size!==Object.keys(ACTIONS).length)result.keys={...DEFAULT_KEYS};
    return result;
  }
  function validateRecord(r) {
    return r && typeof r.id==='string' && r.id.length<100 && hasMode(r.mode) && ['over','won','abandoned'].includes(r.outcome) &&
      ['score','lines','elapsedMs','pieces','tetrises','tspins'].every(k=>Number.isFinite(r[k])&&r[k]>=0&&r[k]<1e14) && Number.isFinite(r.endedAt)&&r.endedAt>0 &&
      (r.autoplayed===undefined||typeof r.autoplayed==='boolean');
  }
  function validateSave(item,mode) {
    if(!item || typeof item.id!=='string' || item.id.length>100 || !Number.isFinite(item.createdAt)) throw Error('存档信息无效');
    const restored=E.Game.restore(item.snapshot);
    if(restored.state.mode!==mode||!['running','paused'].includes(restored.state.status))throw Error('存档状态不正确');
    const result={id:item.id,createdAt:item.createdAt,custom:!!item.custom||restored.state.undoCount>0,assisted:!!item.assisted||!!item.coached||!!item.autoplayed||restored.state.undoCount>0,coached:!!item.coached||!!item.autoplayed,autoplayed:!!item.autoplayed,snapshot:restored.serialize(),updatedAt:Number(item.updatedAt)||Date.now()};
    return result;
  }
  function cleanData(value,strict=false) {
    if(!value||value.version!==1)throw Error('不支持的备份版本');
    const result={version:1,settings:cleanSettings(value.settings,strict),records:[],saves:{}};
    if(!Array.isArray(value.records)||value.records.length>200) { if(strict)throw Error('历史记录格式不正确'); }
    else for(const record of value.records){
      if(record?.mode==='training')continue;
      if(validateRecord(record))result.records.push(record.autoplayed?{...record,assisted:true,coached:true}:record);else if(strict)throw Error('历史记录不完整');
    }
    for(const mode of Object.keys(MODES))if(value.saves?.[mode]) {
      try{result.saves[mode]=validateSave(value.saves[mode],mode);}catch(error){if(strict)throw error;}
    }
    return result;
  }
  let storageFailed=false, loadProblem=false,lastWrittenJSON=null;
  let data;
  try { const raw=localStorage.getItem(STORAGE_KEY);data=raw?cleanData(JSON.parse(raw)):{version:1,settings:clone(DEFAULTS),records:[],saves:{}};lastWrittenJSON=raw; }
  catch {data={version:1,settings:clone(DEFAULTS),records:[],saves:{}};loadProblem=true;}
  let settings=data.settings, mode=settings.lastMode, game, session, dirty=true, pausedBy='manual';
  let lastFrame=0,lastPersist=0,lastPersistAttempt=0,recordFilter='all',bindingAction=null,confirmation=null,toastTimeout,flashTimeout,pendingPersist=null;
  let frameRequest=null,inFrame=false,boardDirty=true,boardColor='#0d111b',holdPreviewKey=null,nextPreviewKey=null,displayedSecond=null;
  let held=new Map(), horizontal=null, softClock=0, draftKeys={...settings.keys},draftAudio=A.normalizeConfig(settings.audio);
  let externalChange=false, saveWritable=!loadProblem;
  const board=$('#board'),ctx=board.getContext('2d'),holdCanvas=$('#hold'),nextCanvas=$('#next');
  const motionPreference=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const boardEffects=new window.PixelEffects.BoardEffects({colors:PIXEL_COLORS,cell:20,hiddenRows:E.HIDDEN_ROWS,cols:E.COLS,rows:E.ROWS-E.HIDDEN_ROWS,reducedMotion:!!motionPreference?.matches});
  let effectsAnimating=false;
  function requestFrame(){if(!inFrame&&frameRequest===null)frameRequest=requestAnimationFrame(frame);}
  function markDirty(boardChanged=true){dirty=true;if(boardChanged)boardDirty=true;requestFrame();}
  motionPreference?.addEventListener?.('change',event=>{boardEffects.setReducedMotion(event.matches);markDirty();});
  const activeStatus=()=>['running','paused'].includes(game.state.status);
  const anyDialog=()=>$$('dialog[open]').length>0;
  let coachResult=null,coachKey=null,coachRequestKey=null,coachView=null,coachRoute=null,coachRouteDirty=true,coachTurn=0,coachError=false,coachNeedsSync=true;
  const COACH_HOLD_MS=650,AUTO_STEP_MS=55,AUTO_RESTART_MS=900,AUTO_STALL_MS=5000;
  let autoPlaying=false,coachPress=null,autoNextAt=0,autoTurnAt=0,autoTurnKey=null,autoTerminalAt=null,autoPlan=null,autoFailures=0;
  const coachClient=new window.PixelCoachClient.Controller({
    analysisOptions:{budgetMs:85,maxDepth:6,beamWidth:5},
    onResult(result,key){
      // The recommendation belongs to a piece, not to its moving pose.
      // A paused game may cache the answer without displaying assistance.
      if((!settings.coach&&!autoPlaying)||!activeStatus()||externalChange||key!==currentCoachKey())return;
      coachResult=result;coachKey=key;coachError=false;coachRouteDirty=true;
      markDirty();
    },
    onError(error,key){if(key!==undefined&&key!==currentCoachKey())return;coachError=true;coachResult=null;markDirty();}
  });

  function coachAllowed(){return (settings.coach||autoPlaying)&&game?.state.status==='running'&&!anyDialog()&&!externalChange;}
  function currentCoachKey(){return session.id+'|'+coachTurn;}
  function currentCoachPosition(){
    const s=game.state;
    // Explicitly project public information: never send bag, seed, RNG or the hidden sixth preview.
    const view={mode:s.mode,board:s.board.map(row=>row.slice()),active:s.active?{...s.active}:null,
      queue:s.queue.slice(0,s.mode==='classic'?1:5),holdType:s.holdType,canHold:s.canHold,
      score:s.score,lines:s.lines,level:s.level,combo:s.combo,b2b:s.b2b,
      lastAction:s.active?.type==='T'&&s.lastAction==='rotate'?'rotate':null,
      lastKick:s.active?.type==='T'&&s.lastAction==='rotate'?(s.lastKick===4?4:0):-1};
    return{view,key:currentCoachKey()};
  }
  function clearCoach(cancel=false){
    coachTurn++;coachResult=null;coachKey=null;coachRequestKey=null;coachView=null;coachRoute=null;coachRouteDirty=true;coachNeedsSync=true;markDirty();
    if(cancel){coachClient.cancel();coachError=false;}
  }
  function configureCoach(){
    coachNeedsSync=true;markDirty();
    if(!settings.coach&&!autoPlaying){coachClient.cancel();coachRequestKey=null;coachError=false;}
  }
  function syncCoach(){
    if(!coachNeedsSync)return;
    coachNeedsSync=false;
    if(!coachAllowed())return;
    const currentKey=currentCoachKey();
    if(coachKey===currentKey||coachRequestKey===currentKey||coachError)return;
    const {view,key}=currentCoachPosition();
    coachRequestKey=key;coachView=clone(view);
    const budgetMs=mode==='zen'?85:Math.min(85,Math.max(3,E.gravityMs(game.state.level,mode)*.4),game.state.config.lockDelay*.25);
    coachClient.request(view,key,{budgetMs,maxDepth:6,beamWidth:5});
  }
  function toggleCoach(){
    if(anyDialog()||externalChange)return;
    settings.coach=!settings.coach;configureCoach();persist();
    toast(autoPlaying?(settings.coach?'落点提示已开启 · 自动继续':'落点提示已关闭 · 自动继续'):settings.coach?'AI 教练已开启 · 显示建议后本局计为练习':'AI 教练已关闭');board.focus({preventScroll:true});
  }
  function cancelCoachPress(){coachPress=null;}
  function beginCoachPress(token){if(!coachPress&&!anyDialog()&&!externalChange){coachPress={token,startedAt:performance.now(),longFired:false};requestFrame();}}
  function releaseCoachPress(token){
    if(!coachPress||coachPress.token!==token)return;
    const press=coachPress;coachPress=null;
    if(press.longFired||anyDialog()||externalChange)return;
    if(performance.now()-press.startedAt>=COACH_HOLD_MS)toggleAutoplay();else toggleCoach();
  }
  function advanceCoachPress(now){
    if(!coachPress||coachPress.longFired||now-coachPress.startedAt<COACH_HOLD_MS)return;
    coachPress.longFired=true;toggleAutoplay();
  }
  function markAutoplaySession(){session.autoplayed=true;session.coached=true;session.assisted=true;updateBest();}
  function stopAutoplay(message=''){
    cancelCoachPress();
    if(!autoPlaying)return false;
    autoPlaying=false;autoPlan=null;autoTurnKey=null;autoTerminalAt=null;autoFailures=0;autoNextAt=0;resetInputs();
    if(settings.coach&&coachResult?.move&&coachKey===currentCoachKey()){
      coachClient.cancel();coachRequestKey=coachKey;coachError=false;coachRouteDirty=true;coachNeedsSync=false;markDirty();
    }else clearCoach(true);
    persist();if(message)toast(message);return true;
  }
  function toggleAutoplay(){
    if(anyDialog()||externalChange)return false;
    if(autoPlaying){stopAutoplay('自动已关闭 · 现在由你操作');return false;}
    autoPlaying=true;autoPlan=null;autoFailures=0;autoTerminalAt=null;autoTurnKey=null;autoNextAt=performance.now();autoTurnAt=autoNextAt;
    resetInputs();
    if(coachResult?.move&&coachKey===currentCoachKey()){coachRouteDirty=true;coachNeedsSync=false;}
    else clearCoach(true);
    if(game.state.status!=='running')startOrResume();
    markAutoplaySession();persist();markDirty();
    toast('AI 自动已开启 · 长按 '+keyName(settings.keys.coach)+' 关闭');board.focus({preventScroll:true});return true;
  }
  function getAutoplayState(){return{active:autoPlaying,pressing:!!coachPress,longFired:!!coachPress?.longFired,nextAt:autoNextAt,waiting:autoPlaying&&!coachResult?.move};}
  function sameTarget(a,b){return a&&b&&['type','x','y','rotation'].every(key=>a.piece?.[key]===b.piece?.[key]);}
  function retryAutoplay(now){
    autoPlan=null;autoFailures++;
    if(autoFailures>2){stopAutoplay('自动已停止 · 当前路径不可用，请手动调整');pause('auto');return;}
    clearCoach(true);autoTurnKey=currentCoachKey();autoTurnAt=now;autoNextAt=now+100;
  }
  function advanceAutoplay(now){
    if(!autoPlaying)return;
    if(externalChange||anyDialog()||document.hidden){stopAutoplay();return;}
    if(['over','won'].includes(game.state.status)){
      if(autoTerminalAt===null)autoTerminalAt=now;
      if(now-autoTerminalAt>=AUTO_RESTART_MS){freshGame();markAutoplaySession();startOrResume();autoTerminalAt=null;autoNextAt=now+AUTO_STEP_MS;}
      return;
    }
    if(game.state.status!=='running'){stopAutoplay();return;}
    if(autoTurnKey!==currentCoachKey()){autoTurnKey=currentCoachKey();autoTurnAt=now;autoPlan=null;}
    if(coachError){stopAutoplay('自动已停止 · AI 暂不可用');pause('auto');return;}
    if(now-autoTurnAt>AUTO_STALL_MS){retryAutoplay(now);return;}
    if(now<autoNextAt||!coachResult?.move||coachKey!==currentCoachKey())return;
    const target=coachResult.move,view=currentCoachPosition().view,spin=coachResult.metrics?.spin;
    if(!autoPlan||autoPlan.key!==coachKey||!sameTarget(autoPlan.move,target))autoPlan={key:coachKey,move:clone(target),path:target.path.slice(),spin};
    let planned={...autoPlan.move,hold:autoPlan.path[0]==='hold',path:autoPlan.path.slice()};
    let validation=C.applyPath(view,planned);
    if(!validation.valid||(spin&&validation.clear?.spin!==spin)){
      const route=C.routeTo(view,{...target,path:autoPlan.path},{budgetMs:5,spin});
      if(!route){retryAutoplay(now);return;}
      autoPlan={key:coachKey,move:clone(target),path:route.path.slice(),spin};planned={...route};validation=C.applyPath(view,planned);
      if(!validation.valid||(spin&&validation.clear?.spin!==spin)){retryAutoplay(now);return;}
    }
    const step=autoPlan.path.shift(),name={left:'left',right:'right',cw:'rotate',ccw:'ccw',soft:'soft',hard:'hard',hold:'hold'}[step];
    if(!name){retryAutoplay(now);return;}
    autoNextAt=now+AUTO_STEP_MS;
    const plan=autoPlan;
    if(!action(name,true)){retryAutoplay(now);return;}
    if(step==='hold'){
      if(coachResult?.move&&!coachResult.move.hold&&sameTarget(coachResult.move,target)){
        plan.key=coachKey;plan.move={...plan.move,hold:false};autoTurnKey=coachKey;autoPlan=plan;
      }else{retryAutoplay(now);return;}
    }else if(step==='hard'){autoPlan=null;autoFailures=0;autoTurnKey=currentCoachKey();autoTurnAt=now;}
    coachRoute=autoPlan?{...autoPlan.move,hold:autoPlan.path[0]==='hold',path:autoPlan.path.slice()}:null;markDirty();
  }
  function coachPath(move){
    const action={left:'left',right:'right',cw:'rotate',ccw:'ccw',soft:'soft',hard:'hard',hold:'hold'},groups=[];
    for(const step of move.path){const previous=groups.at(-1);if(previous?.step===step)previous.count++;else groups.push({step,count:1});}
    return groups.map(({step,count})=>(step==='hold'?'暂存 ':'')+keyName(settings.keys[action[step]])+(count>1?'×'+count:'')).join(' → ');
  }
  function carryCoachThroughHold(events){
    const move=coachResult?.move,s=game.state;
    if(!move?.hold||!coachView||coachKey!==currentCoachKey()||!events.some(e=>e.type==='hold')||events.some(e=>['lock','undo','gameover','win'].includes(e.type)))return false;
    if(!s.active||s.active.type!==move.piece.type||s.holdType!==coachView.active.type||s.canHold||JSON.stringify(s.board)!==JSON.stringify(coachView.board))return false;
    const expected=coachView.holdType?coachView.queue:coachView.queue.slice(1);
    if(expected.some((piece,i)=>s.queue[i]!==piece))return false;
    const continued={...move,hold:false,path:move.path[0]==='hold'?move.path.slice(1):move.path.slice()};
    if(!C.applyPath(currentCoachPosition().view,continued).valid)return false;
    const cached={...coachResult,move:continued};clearCoach(true);
    coachResult=cached;coachKey=currentCoachKey();coachRequestKey=coachKey;coachView=currentCoachPosition().view;coachRoute=continued;coachRouteDirty=false;
    return true;
  }
  function syncInstructions(){
    if(coachAllowed()&&coachResult?.move&&coachRouteDirty){
      coachRouteDirty=false;coachRoute=autoPlaying&&autoPlan?.key===coachKey?{...autoPlan.move,hold:autoPlan.path[0]==='hold',path:autoPlan.path.slice()}:C.routeTo(currentCoachPosition().view,coachResult.move,{budgetMs:4,spin:coachResult.metrics?.spin});
    }

  }
  function renderCoach(){
    const enabled=settings.coach||autoPlaying,ready=settings.coach&&coachAllowed()&&coachResult?.move;
    // Mark assistance only once a usable recommendation is actually drawn.
    if(ready&&!session.coached){session.coached=true;session.assisted=true;persist();updateBest();}
    putAttribute('#coachBtn','aria-pressed',String(settings.coach));put('#coachSwitch',autoPlaying?'AUTO':enabled?'ON':'OFF');
    $('#coachPanel').classList.toggle('enabled',enabled);
    $('#coachPanel').classList.toggle('autoplaying',autoPlaying);
    put('#coachReason',autoPlaying?(coachError?'AI 暂不可用':coachResult?'自动操作中':'自动中 · 正在分析…'):!enabled?'短按 '+keyName(settings.keys.coach)+' 提示 · 长按自动':!coachAllowed()?'继续后显示操作':coachError?'暂不可用，关闭后可重新开启':coachResult?'当前没有安全落点':'正在分析…');
    putProperty('#coachReason','hidden',!!ready||!enabled);
    put('#coachPath',ready?(coachRoute?coachPath(coachRoute):game.canUndo()?keyName(settings.keys.undo)+' 撤销调整':'路径暂不可用'):'');
    const xs=ready?coachResult.move.cells.map(c=>c.x+1):[];
    put('#coachMeta',autoPlaying?'自动中 · 长按 '+keyName(settings.keys.coach)+' 关闭':ready?coachResult.move.piece.type+' · 第 '+Math.min(...xs)+'–'+Math.max(...xs)+' 列 · 目标固定':enabled?'白色虚线 AI 标记':'');
    putProperty('#coachPath','hidden',!ready);putProperty('#coachMeta','hidden',!enabled);
  }

  function toast(message) { clearTimeout(toastTimeout);$('#toast').textContent=message;$('#toast').classList.add('visible');toastTimeout=setTimeout(()=>$('#toast').classList.remove('visible'),3600); }
  function writeData() {
    if(!saveWritable||externalChange)return false;
    try{const json=JSON.stringify(data);if(json!==lastWrittenJSON){localStorage.setItem(STORAGE_KEY,json);lastWrittenJSON=json;}storageFailed=false;putHTML('#saveStatus','<i></i> 自动保存');return true;}
    catch {if(!storageFailed)toast('本机存储不可用，请在设置中导出备份。');storageFailed=true;$('#saveStatus').textContent='存档失败 · 请导出备份';return false;}
  }
  function persist() {
    if(pendingPersist!==null){clearTimeout(pendingPersist);pendingPersist=null;}
    lastPersistAttempt=performance.now();
    if(activeStatus()){const isNew=!data.saves[mode];data.saves[mode]={...session,snapshot:game.serialize(),updatedAt:Date.now()};if(isNew)updateModes();}
    data.settings=settings;
    const saved=writeData();if(saved)lastPersist=lastPersistAttempt;return saved;
  }
  function schedulePersist(){if(pendingPersist===null)pendingPersist=setTimeout(()=>{pendingPersist=null;persist();},Math.max(0,1000-(performance.now()-Math.max(lastPersist,lastPersistAttempt))));}
  function resetInputs(){held.clear();horizontal=null;softClock=0;}
  function clearBoardEffects(){boardEffects.clear();effectsAnimating=false;markDirty();}
  function pause(reason='manual') {
    stopAutoplay();cancelCoachPress();
    resetInputs();clearBoardEffects();
    if(game.state.status==='running'){game.pause();pausedBy=reason;drain();persist();markDirty();}
  }
  function persistAndPause(){pause('away');persist();return true;}
  window.PixelStack={persistAndPause,undo:undoMove,toggleAutoplay,stopAutoplay,getAutoplayState,openSettings:()=>{if(!anyDialog())openDialog('settings');}};
  function freshGame() {
    clearCoach(true);clearBoardEffects();
    clearTimeout(flashTimeout);$('#gameFlash').classList.remove('show');soundEngine.stop('softdrop');
    session={id:id(),createdAt:Date.now(),custom:settings.startLevel!==1||settings.lockDelay!==500};
    game=new E.Game({mode,startLevel:settings.startLevel,lockDelay:settings.lockDelay});pausedBy='manual';
    resetInputs();markDirty();
  }
  function loadMode() {
    stopAutoplay();cancelCoachPress();
    clearCoach(true);clearBoardEffects();
    const save=data.saves[mode];
    if(save){try{game=E.Game.restore(save.snapshot);game.pause();game.drainEvents();session={id:save.id,createdAt:save.createdAt,custom:!!save.custom||game.state.undoCount>0,assisted:!!save.assisted||!!save.coached||!!save.autoplayed||game.state.undoCount>0,coached:!!save.coached||!!save.autoplayed,autoplayed:!!save.autoplayed};pausedBy='restore';
    }catch{delete data.saves[mode];freshGame();toast('这份进度无法恢复，已保留其他模式的存档。');}}
    else freshGame();
    resetInputs();markDirty();updateModes();updateBest();
  }
  function changeMode(next) {
    if(mode===next)return;
    pause('mode');persist();mode=next;settings.lastMode=mode;loadMode();persist();
  }
  function startOrResume() {
    if(anyDialog()||externalChange)return;
    unlockAudio();resetInputs();
    if(game.state.status==='ready')game.start();
    else if(game.state.status==='paused')game.resume();
    else if(['over','won'].includes(game.state.status)){freshGame();game.start();}
    drain();persist();markDirty();board.focus({preventScroll:true});lastFrame=performance.now();
  }
  function record(outcome) {
    const s=game.state;
    if(data.records.some(r=>r.id===session.id))return;
    if(outcome==='abandoned'&&s.elapsedMs===0&&s.pieces===0)return;
    data.records.unshift({id:session.id,mode,outcome,score:s.score,lines:s.lines,elapsedMs:s.elapsedMs,pieces:s.pieces,tetrises:s.tetrises,tspins:s.tspins,endedAt:Date.now(),custom:session.custom||s.undoCount>0,assisted:!!session.assisted||!!session.coached||!!session.autoplayed||s.undoCount>0,coached:!!session.coached||!!session.autoplayed,autoplayed:!!session.autoplayed,undoCount:s.undoCount,startLevel:s.config.startLevel,lockDelay:s.config.lockDelay});
    data.records=data.records.slice(0,200);delete data.saves[mode];writeData();updateBest();updateModes();
  }
  function confirmAction(title,description,label,action) {
    pause('dialog');confirmation=action;$('#confirmTitle').textContent=title;$('#confirmDescription').textContent=description;$('#confirmAccept').textContent=label;$('#confirmDialog').showModal();$('#confirmAccept').focus();
  }
  function restart() {
    stopAutoplay();cancelCoachPress();
    const run=()=>{record('abandoned');delete data.saves[mode];freshGame();startOrResume();};
    if(activeStatus())confirmAction('重新开始？','当前这一局会计入历史，作为「中途结束」。其他模式的存档会保留。','重新开始',run);
    else run();
  }

  function unlockAudio(){if(settings.sound)soundEngine.unlock();}
  function beep(kind){if(settings.sound)soundEngine.play(kind);}
  function flash(text){clearTimeout(flashTimeout);const el=$('#gameFlash');el.textContent=text;el.classList.remove('show');void el.offsetWidth;el.classList.add('show');flashTimeout=setTimeout(()=>el.classList.remove('show'),1100);}
  function drain() {
    const events=game.drainEvents();
    if(!events.length)return false;
    const manualDrop=events.some(event=>event.type==='harddrop');
    // Send sound before coach validation, animations, layout, or storage.
    for(const event of events){
      if(event.type==='clear'){beep(event.perfect?'perfect':event.spin?'tspin':event.lines===4?'tetris':'clear');if(event.combo>0)beep('combo');}
      else if(event.type==='lock'){if(!manualDrop)beep('lock');}
      else if(A.EVENTS.some(item=>item.id===event.type))beep(event.type);
    }
    boardEffects.consume(events,performance.now());
    if(events.length){
      if(events.some(event=>['spawn','hold','lock','undo','gameover','win'].includes(event.type))){if(!carryCoachThroughHold(events))clearCoach(true);}
      else if(events.some(event=>['start','resume'].includes(event.type)))coachNeedsSync=true;
      coachRouteDirty=true;
      if(events.some(event=>event.type==='lock'))autoFailures=0;
    }
    for(const event of events) {
      if(event.type==='clear'){
        const label=event.spin==='full'?'T-SPIN':event.spin==='mini'?'MINI T-SPIN':['','SINGLE','DOUBLE','TRIPLE','TETRIS'][event.lines]||'';
        flash(`${event.perfect?'ALL CLEAR':label}${event.combo>0?'\n'+event.combo+' COMBO':''}`);
      }else if(event.type==='gameover'||event.type==='win'){resetInputs();record(game.state.status);}
    }
    markDirty();return true;
  }
  function undoMove(){
    stopAutoplay();cancelCoachPress();
    if(anyDialog()||externalChange)return false;
    if(!game.canUndo()){toast(game.state.mode==='ultra'&&game.state.elapsedMs>=120000?'计时已结束，不能撤销。':'还没有可撤销的落子；新落子后可用。');return false;}
    if(!game.undo())return false;
    resetInputs();clearBoardEffects();session.custom=true;session.assisted=true;
    data.records=data.records.filter(record=>record.id!==session.id);
    clearTimeout(flashTimeout);$('#gameFlash').classList.remove('show');pausedBy='manual';
    drain();updateBest();persist();markDirty();return true;
  }
  function action(name,automated=false) {
    if(name==='undo'){undoMove();return;}
    if(name==='coach'){toggleCoach();return;}
    if(!automated&&autoPlaying)stopAutoplay('自动已关闭 · 现在由你操作');
    if(game.state.status!=='running'||anyDialog()||externalChange)return false;
    let changed=false;
    if(name==='left')changed=game.move(-1);else if(name==='right')changed=game.move(1);else if(name==='soft'){changed=game.softDrop();if(!changed)soundEngine.stop('softdrop');}
    else if(name==='hard')changed=game.hardDrop()!==false;else if(name==='hold')changed=game.hold();else if(name==='rotate')changed=game.rotate(1);else if(name==='ccw')changed=game.rotate(-1);else if(name==='half')changed=game.rotate(2);
    drain();if(changed)schedulePersist();return changed;
  }
  function press(name,token) {
    if(name==='coach'){beginCoachPress(token);return;}
    cancelCoachPress();if(autoPlaying)stopAutoplay('自动已关闭 · 现在由你操作');
    if(held.has(token))return;held.set(token,name);action(name);
    if(name==='left'||name==='right')horizontal={name,token,time:0,repeating:false,remainder:0};
    if(name==='soft')softClock=0;
  }
  function release(token) {
    releaseCoachPress(token);
    held.delete(token);
    if(horizontal?.token===token){horizontal=null;const other=Array.from(held.entries()).reverse().find(([,name])=>name==='left'||name==='right');if(other){horizontal={name:other[1],token:other[0],time:0,repeating:false,remainder:0};action(other[1]);}}
  }
  function repeatInputs(dt) {
    if(horizontal){horizontal.time+=dt;if(horizontal.time>=settings.das){
      let count=0;
      if(!horizontal.repeating){count=1;horizontal.repeating=true;horizontal.remainder=horizontal.time-settings.das;}
      else horizontal.remainder+=dt;
      if(settings.arr===0)count=10;else {count+=Math.floor(horizontal.remainder/settings.arr);horizontal.remainder%=settings.arr;}
      for(let i=0;i<Math.min(count,12);i++)game.move(horizontal.name==='left'?-1:1);
      if(count)drain();
    }}
    let softHeld=false;for(const name of held.values())if(name==='soft'){softHeld=true;break;}
    if(softHeld){softClock+=dt;let count=0;while(softClock>=settings.softInterval&&count++<25){if(!game.softDrop()){soundEngine.stop('softdrop');softClock=0;break;}softClock-=settings.softInterval;}if(count)drain();}
  }

  function block(context,x,y,size,type,ghost=false,dim=false) {
    if(!PIXEL_COLORS[type])return;
    const color=PIXEL_COLORS[type];x=Math.round(x);y=Math.round(y);size=Math.round(size);context.save();context.imageSmoothingEnabled=false;if(dim)context.globalAlpha=.3;
    if(ghost){
      context.fillStyle=color+'12';context.fillRect(x+1,y+1,size-2,size-2);context.fillStyle=color+'80';
      for(const [cx,cy,sx,sy]of [[x+1,y+1,1,1],[x+size-2,y+1,-1,1],[x+1,y+size-2,1,-1],[x+size-2,y+size-2,-1,-1]]){
        context.fillRect(sx>0?cx:cx-3,cy,4,1);context.fillRect(cx,sy>0?cy:cy-3,1,4);
      }
    }else{
      context.fillStyle=color;context.fillRect(x+1,y+1,size-2,size-2);
      context.fillStyle='#ffffff65';context.fillRect(x+1,y+1,size-2,2);context.fillRect(x+1,y+1,2,size-2);
      context.fillStyle='#080d2266';context.fillRect(x+1,y+size-3,size-2,2);context.fillRect(x+size-3,y+1,2,size-2);
      if(size>=16){context.fillStyle='#080d221c';context.fillRect(x+5,y+5,size-10,size-10);context.fillStyle='#ffffff30';context.fillRect(x+5,y+5,size-10,1);}
    }
    context.restore();
  }
  function drawBoard(now=performance.now()) {
    const s=game.state,cell=20;ctx.imageSmoothingEnabled=false;ctx.fillStyle=boardColor;ctx.fillRect(0,0,board.width,board.height);
    const offset=boardEffects.offset(now);ctx.save();ctx.translate(offset.x,offset.y);
    if(settings.grid){ctx.fillStyle='#8b9aba15';for(let i=1;i<10;i++)ctx.fillRect(i*cell-1,0,1,400);for(let i=1;i<20;i++)ctx.fillRect(0,i*cell-1,200,1);}
    for(let y=E.HIDDEN_ROWS;y<E.ROWS;y++)for(let x=0;x<E.COLS;x++)if(s.board[y][x])block(ctx,x*cell,(y-E.HIDDEN_ROWS)*cell,cell,s.board[y][x]);
    if(s.active){
      if(settings.ghost&&mode!=='classic')for(const {x,y}of E.getCells({...s.active,y:E.ghostY(s)}))if(y>=E.HIDDEN_ROWS)block(ctx,x*cell,(y-E.HIDDEN_ROWS)*cell,cell,s.active.type,true);
      for(const {x,y}of E.getCells(s.active))if(y>=E.HIDDEN_ROWS)block(ctx,x*cell,(y-E.HIDDEN_ROWS)*cell,cell,s.active.type);
    }
    if(settings.coach&&coachAllowed()&&coachResult?.move)drawCoachTarget(coachResult.move.cells,cell);
    effectsAnimating=boardEffects.draw(ctx,now);
    ctx.restore();
  }
  function drawCoachTarget(cells,cell,tag='AI'){
    const visible=cells.filter(({y})=>y>=E.HIDDEN_ROWS);if(!visible.length)return;
    const occupied=new Set(cells.map(({x,y})=>x+','+y));
    ctx.save();ctx.beginPath();
    for(const {x,y}of visible){
      const left=x*cell,top=(y-E.HIDDEN_ROWS)*cell;
      for(const [dx,dy,x1,y1,x2,y2]of [[0,-1,left,top+1,left+cell,top+1],[0,1,left,top+cell-1,left+cell,top+cell-1],[-1,0,left+1,top,left+1,top+cell],[1,0,left+cell-1,top,left+cell-1,top+cell]]){
        if(!occupied.has((x+dx)+','+(y+dy))){ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);}
      }
    }
    // A neutral dashed silhouette and a tiny pixel AI badge distinguish the
    // coach from both coloured pieces and their corner-shaped landing ghost.
    ctx.strokeStyle='#070c14';ctx.lineWidth=3;ctx.stroke();
    ctx.strokeStyle='#f2f6ff';ctx.lineWidth=1;ctx.setLineDash([3,2]);ctx.stroke();ctx.setLineDash([]);
    const width=tag==='TIP'?20:15,bx=Math.min(199-width,Math.max(0,Math.min(...visible.map(c=>c.x))*cell));
    const by=Math.max(1,Math.min(...visible.map(c=>c.y-E.HIDDEN_ROWS))*cell-10);
    ctx.fillStyle='#eaf2ff';ctx.fillRect(bx,by,width,9);ctx.fillStyle='#111a27';ctx.fillRect(bx+1,by+1,width-2,7);
    ctx.fillStyle='#f2f6ff';
    const glyphs={A:'010101111101101',I:'111010010010111',T:'111010010010010',P:'110101110100100'};
    [...tag].forEach((letter,index)=>{const glyph=glyphs[letter];for(let i=0;i<glyph.length;i++)if(glyph[i]==='1')ctx.fillRect(bx+3+index*5+i%3,by+2+Math.floor(i/3),1,1);});
    ctx.restore();
  }
  function drawPiece(context,type,centerX,centerY,size=30,dim=false) {
    if(!type)return;const cells=E.SHAPES[type][0],xs=cells.map(c=>c[0]),ys=cells.map(c=>c[1]);
    const minX=Math.min(...xs),minY=Math.min(...ys),w=Math.max(...xs)-minX+1,h=Math.max(...ys)-minY+1;
    for(const[x,y]of cells)block(context,centerX-w*size/2+(x-minX)*size,centerY-h*size/2+(y-minY)*size,size,type,false,dim);
  }
  function drawPreviews() {
    const s=game.state,holdKey=mode+'|'+s.holdType+'|'+s.canHold;
    if(holdKey!==holdPreviewKey){
      holdPreviewKey=holdKey;
      const hc=holdCanvas.getContext('2d');hc.clearRect(0,0,holdCanvas.width,holdCanvas.height);
      if(mode==='classic'){$('.hold-tray').style.opacity='.35';hc.fillStyle='#8793a7';hc.fillRect(55,20,10,2);}
      else{$('.hold-tray').style.opacity='1';drawPiece(hc,s.holdType,60,21,16,!s.canHold);}
    }
    const next=s.queue.slice(0,mode==='classic'?1:5),nextKey=mode+'|'+next.join('');
    if(nextKey!==nextPreviewKey){
      nextPreviewKey=nextKey;
      const nc=nextCanvas.getContext('2d');nc.clearRect(0,0,nextCanvas.width,nextCanvas.height);
      next.forEach((type,i)=>drawPiece(nc,type,50,23+i*54,20));put('#nextCount',mode==='classic'?'1':'5');
    }
  }
  function put(selector,text){const el=$(selector),value=String(text);if(el.textContent!==value)el.textContent=value;}
  function putHTML(selector,html){const el=$(selector);if(el.innerHTML!==html)el.innerHTML=html;}
  function putProperty(selector,key,value){const el=$(selector);if(el[key]!==value)el[key]=value;}
  function putAttribute(selector,key,value){const el=$(selector);if(el.getAttribute(key)!==value)el.setAttribute(key,value);}
  function renderClock(){
    const ms=mode==='ultra'?120000-game.state.elapsedMs:game.state.elapsedMs,second=Math.floor(Math.max(0,ms)/1000);
    if(second!==displayedSecond){displayedSecond=second;put('#time',formatTime(ms));}
  }
  function render(now=performance.now()) {
    const s=game.state;if(boardDirty){drawBoard(now);boardDirty=false;}drawPreviews();renderCoach();
    put('#score',String(s.score).padStart(6,'0'));put('#lines',mode==='sprint'?`${s.lines} / 40`:s.lines);put('#level',String(s.level).padStart(2,'0'));
    put('#timeLabel',mode==='ultra'?'LEFT / 剩余':'TIME / 用时');renderClock();put('#pieceCounter',String(s.pieces).padStart(3,'0')+' BLOCKS');
    put('#statusText',autoPlaying?(s.status==='running'?'AI 自动中':'AI 自动中 · 稍后再来'):{ready:'准备就绪',running:session.assisted?'游戏中 · 练习':session.custom?'游戏中 · 自定义':'游戏进行中',paused:session.assisted?'已暂停 · 练习':'已暂停 · 已存档',over:'本局结束',won:'挑战完成'}[s.status]);
    putProperty('#undoBtn','disabled',!game.canUndo());
    const statusColor=s.status==='running'?'var(--accent)':'var(--muted)',statusStyle=$('.status-dot').style;if(statusStyle.background!==statusColor)statusStyle.background=statusColor;
    put('#pauseBtn',s.status==='running'?'Ⅱ':'▷');putProperty('#pauseBtn','disabled',s.status==='ready'||['over','won'].includes(s.status));
    putProperty('#gameOverlay','hidden',s.status==='running');putProperty('#freshBtn','hidden',s.status!=='paused');
    if(s.status==='ready'){put('#overlayEyebrow','PLAYER 01');put('#overlayTitle','READY?');put('#overlayDescription',mode==='zen'?'无自动下落\n用软降或空格放置方块':'准备好了，随时开局。');putHTML('#startBtn','开始游戏 <kbd>ENTER</kbd>');}
    else if(s.status==='paused'){put('#overlayEyebrow',pausedBy==='restore'?'SAVE LOADED':'PLAYER 01');put('#overlayTitle','PAUSED');put('#overlayDescription',externalChange?'另一窗口更新了存档。\n请重新载入最新进度。':'进度已保存\n按 ENTER 继续游戏');putHTML('#startBtn',externalChange?'载入进度 <kbd>ENTER</kbd>':'继续游戏 <kbd>ENTER</kbd>');}
    else if(['over','won'].includes(s.status)){put('#overlayEyebrow',autoPlaying?'AUTO PLAY':'PLAYER 01');put('#overlayTitle',s.status==='won'?'CLEAR!':'GAME OVER');put('#overlayDescription',`${number(s.score)} 分 · ${s.lines} 行\n${formatTime(s.elapsedMs,true)} · ${autoPlaying?'自动继续下一局':'已记录'}`);putHTML('#startBtn','再来一局 <kbd>ENTER</kbd>');}
    dirty=false;
  }
  function updateModes(){
    $$('#modes button').forEach(btn=>{btn.classList.toggle('selected',btn.dataset.mode===mode);btn.setAttribute('aria-pressed',btn.dataset.mode===mode?'true':'false');btn.tabIndex=btn.dataset.mode===mode?0:-1;btn.querySelector('.mode-save').hidden=!data.saves[btn.dataset.mode];});
    $('#modeIndex').textContent=String(Object.keys(MODES).indexOf(mode)+1).padStart(2,'0')+' / '+MODES[mode].en.split(' /')[0];$('#modeDescription').textContent=MODES[mode].description;
  }
  function updateBest() {
    const records=data.records.filter(r=>r.mode===mode&&r.outcome!=='abandoned'&&!r.custom&&!r.assisted&&!r.coached&&!r.autoplayed&&!(r.undoCount>0)&&(mode!=='sprint'||r.outcome==='won'));
    $('#bestLabel').textContent=mode==='sprint'?'最快完成 · 标准参数':'最高得分 · 标准参数';
    $('#personalBest').textContent=records.length?(mode==='sprint'?formatTime(Math.min(...records.map(r=>r.elapsedMs)),true):number(Math.max(...records.map(r=>r.score)))):'—';
  }
  function refreshKeyGuide() {
    const keys=settings.keys;
    $('.key-guide').innerHTML=`<span><kbd>${keyName(keys.left)}</kbd><kbd>${keyName(keys.right)}</kbd> 移动</span><span><kbd>${keyName(keys.rotate)}</kbd> 旋转</span><span><kbd>${keyName(keys.hard)}</kbd> 落下</span><span><kbd>${keyName(keys.hold)}</kbd> 暂存</span><span><kbd>Esc</kbd> 暂停</span>`;
    $('.tray-title kbd').textContent=keyName(keys.hold);$('#helpKeys').replaceChildren();
    $('#undoKeyLabel').textContent=keyName(keys.undo);$('#undoBtn').title='撤销上一次落子 · '+keyName(keys.undo);
    $('#coachKeyLabel').textContent=keyName(keys.coach);$('#coachBtn').title='短按 '+keyName(keys.coach)+' 切换提示 · 长按自动玩 / 关闭自动';
    for(const [action,title]of Object.entries(ACTIONS)){const row=document.createElement('div');const text=document.createElement('span');text.textContent=title;const key=document.createElement('kbd');key.textContent=keyName(keys[action]);row.append(text,key);$('#helpKeys').append(row);}
    for(const [title,shortcut]of [['开始 / 继续','Enter'],['暂停 / 继续','Esc / P'],['重开后确认','R → Enter'],['设置','S / ⌘,'],['记录 / 指南','L / H'],['切换模式','1–5'],['保存设置','⌘ / Ctrl + Enter']]){const row=document.createElement('div');const text=document.createElement('span');text.textContent=title;const key=document.createElement('kbd');key.textContent=shortcut;row.append(text,key);$('#helpKeys').append(row);}
    const autoRow=document.createElement('div'),autoText=document.createElement('span'),autoKey=document.createElement('kbd');autoText.textContent='AI 自动连续玩 / 关闭';autoKey.textContent='长按 '+keyName(keys.coach)+' 约 0.7 秒';autoRow.append(autoText,autoKey);$('#helpKeys').append(autoRow);
  }

  function openDialog(name){pause('dialog');resetInputs();if(name==='settings')fillSettings();if(name==='records')renderRecords();$(`#${name}Dialog`).showModal();}
  function restoreAudioSettings(){if(!settings.sound)soundEngine.setEnabled?.(false);soundEngine.configure(settings.audio);if(settings.sound)soundEngine.setEnabled?.(true);}
  function closeDialog(dialog){dialog.close();bindingAction=null;confirmation=null;restoreAudioSettings();board.focus({preventScroll:true});markDirty();}
  function fillSettings(){
    for(const name of Object.keys(RANGES))$('#settingsForm').elements[name].value=settings[name];
    for(const name of ['ghost','grid','sound','coach'])$('#settingsForm').elements[name].checked=settings[name];
    $('#settingsForm').elements.theme.value=settings.theme;draftKeys={...settings.keys};draftAudio=A.normalizeConfig(settings.audio);$('#settingsForm').elements.volume.value=draftAudio.volume;$('#volumeValue').textContent=draftAudio.volume+'%';renderKeyBindings();renderSoundLibrary();
    $('#storageInfo').textContent=`${Object.keys(data.saves).length} 份进行中存档 · ${data.records.length} 局历史记录${storageFailed?' · 本机存储不可用，请导出备份':''}`;
  }
  function readDraftAudio(){return{volume:Number($('#settingsForm').elements.volume.value),map:{...draftAudio.map}};}
  function renderSoundLibrary(){
    const library=$('#soundLibrary');library.replaceChildren();
    for(const event of A.EVENTS){
      const row=document.createElement('div');row.className='sound-row';
      const label=document.createElement('label');label.htmlFor='sound-'+event.id;label.textContent=event.label;
      const select=document.createElement('select');select.id='sound-'+event.id;
      for(const preset of A.PRESETS){const option=document.createElement('option');option.value=preset.id;option.textContent=preset.label;select.append(option);}
      select.value=draftAudio.map[event.id];select.onchange=()=>{draftAudio.map[event.id]=select.value;};
      const preview=document.createElement('button');preview.type='button';preview.className='sound-preview';preview.textContent='试听';preview.setAttribute('aria-label','试听'+event.label);preview.onclick=()=>{soundEngine.configure(readDraftAudio());soundEngine.setEnabled?.(true);soundEngine.unlock();soundEngine.preview(select.value);};
      row.append(label,select,preview);library.append(row);
    }
  }
  function renderKeyBindings(){
    $('#keyBindings').replaceChildren();
    for(const [action,label]of Object.entries(ACTIONS)){
      const row=document.createElement('div');row.className='key-row';const text=document.createElement('span');text.textContent=label;
      const btn=document.createElement('button');btn.type='button';btn.className='key-bind'+(bindingAction===action?' listening':'');btn.textContent=bindingAction===action?'请按新键…':keyName(draftKeys[action]);btn.onclick=()=>{bindingAction=action;renderKeyBindings();};row.append(text,btn);$('#keyBindings').append(row);
    }
  }
  function renderRecords(){
    const complete=data.records.filter(r=>r.outcome!=='abandoned');
    $('#recordStats').innerHTML=`<div><small>玩过的局数</small><strong>${data.records.length}</strong></div><div><small>累计消行</small><strong>${number(data.records.reduce((sum,r)=>sum+r.lines,0))}</strong></div><div><small>挑战完成</small><strong>${complete.filter(r=>r.outcome==='won').length}</strong></div>`;
    $('#recordFilters').replaceChildren();for(const [key,label]of [['all','全部'],...Object.entries(MODES).map(([key,val])=>[key,val.name])]){
      const btn=document.createElement('button');btn.textContent=label;btn.className=recordFilter===key?'active':'';btn.onclick=()=>{recordFilter=key;renderRecords();};$('#recordFilters').append(btn);
    }
    const list=$('#recordList');list.replaceChildren();const records=data.records.filter(r=>recordFilter==='all'||r.mode===recordFilter);
    if(!records.length){const empty=document.createElement('div');empty.className='record-empty';empty.textContent='还没有记录。\n从随手一局开始吧。';list.append(empty);}
    records.forEach(r=>{
      const item=document.createElement('div');item.className='record-item';const left=document.createElement('div');const title=document.createElement('strong');title.textContent=MODES[r.mode].name+(r.autoplayed?' · AI 自动 · 练习':r.coached?' · 教练练习':r.assisted||r.undoCount>0?' · 练习':r.custom?' · 自定义':'');
      const sub=document.createElement('small');sub.textContent=new Date(r.endedAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})+' · '+({over:'结束',won:'完成',abandoned:'中途结束'}[r.outcome]);left.append(title,sub);
      const right=document.createElement('div');right.className='record-value';right.textContent=r.mode==='sprint'&&r.outcome==='won'?formatTime(r.elapsedMs,true):number(r.score)+' 分';const detail=document.createElement('small');detail.textContent=`${r.lines} 行 · ${r.pieces} 块 · ${formatTime(r.elapsedMs)}`;right.append(detail);item.append(left,right);list.append(item);
    });
  }
  function exportData(){
    persist();const blob=new Blob([JSON.stringify({...data,exportedAt:new Date().toISOString()},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=`Tetris备份_${new Date().toLocaleDateString('sv-SE')}.json`;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);toast('已发起备份导出，请保存 JSON 文件。');
  }
  function importData(file){
    stopAutoplay();cancelCoachPress();
    if(!file)return;if(file.size>2*1024*1024){toast('备份文件过大，最大支持 2 MB。');return;}
    file.text().then(text=>{
      let incoming;try{incoming=cleanData(JSON.parse(text),true);}catch(error){toast('导入失败：'+error.message);return;}
      confirmAction('恢复这份备份？',`包含 ${Object.keys(incoming.saves).length} 份进度和 ${incoming.records.length} 局历史。将替换当前本地数据；需要时请先导出原备份。`,'恢复备份',()=>{data=incoming;settings=data.settings;mode=settings.lastMode;saveWritable=true;externalChange=false;loadMode();applyTheme();refreshKeyGuide();persist();fillSettings();toast('备份已恢复，可以继续游戏。');});
    }).catch(()=>toast('无法读取这份备份。'));
  }
  function applyTheme(){document.body.dataset.theme=settings.theme;boardColor=getComputedStyle(document.body).getPropertyValue('--board').trim()||'#0d111b';restoreAudioSettings();markDirty();}
  function toggleFullscreen(){if(document.fullscreenElement)document.exitFullscreen?.();else document.documentElement.requestFullscreen?.().catch(()=>toast('当前窗口不支持网页全屏，可使用窗口左上角的绿色按钮。'));}
  function activateSettingsTab(name,focus=false){
    bindingAction=null;
    $$('[data-settings-tab]').forEach(button=>{const active=button.dataset.settingsTab===name;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;if(active&&focus)button.focus();});
    $$('[data-settings-panel]').forEach(panel=>panel.hidden=panel.dataset.settingsPanel!==name);renderKeyBindings();
  }
  function focusByTab(container,backward){
    const controls=Array.from(container.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(element=>element.tabIndex>=0&&element.getClientRects().length);
    if(!controls.length)return;
    const current=controls.indexOf(document.activeElement),next=current<0?(backward?controls.length-1:0):(current+(backward?-1:1)+controls.length)%controls.length;
    controls[next].focus({preventScroll:true});controls[next].scrollIntoView({block:'nearest',inline:'nearest'});
  }

  for(const [key,meta]of Object.entries(MODES)){
    const btn=document.createElement('button');btn.className='mode-button';btn.dataset.mode=key;btn.innerHTML=`<span class="mode-icon" aria-hidden="true">${meta.icon}</span><span class="mode-title">${meta.name}<span class="mode-english">${meta.en}</span></span><span class="mode-arrow" aria-hidden="true">▶</span><i class="mode-save" title="有未完成进度" hidden></i>`;btn.onclick=()=>changeMode(key);$('#modes').append(btn);
  }
  $('#startBtn').onclick=()=>{if(externalChange)location.reload();else startOrResume();};$('#pauseBtn').onclick=()=>{if(game.state.status==='paused')startOrResume();else pause();};$('#restartBtn').onclick=restart;$('#freshBtn').onclick=restart;$('#undoBtn').onclick=undoMove;
  $('#recordsBtn').onclick=()=>openDialog('records');$('#settingsBtn').onclick=()=>openDialog('settings');$('#helpBtn').onclick=()=>openDialog('help');$('#fullscreenBtn').onclick=toggleFullscreen;
  $('#coachBtn').onclick=toggleCoach;
  $('.brand').onclick=event=>{event.preventDefault();pause();};
  $$('[data-close]').forEach(btn=>btn.onclick=()=>closeDialog(btn.closest('dialog')));
  $$('dialog').forEach(dialog=>{dialog.addEventListener('cancel',()=>{bindingAction=null;confirmation=null;markDirty();});dialog.addEventListener('close',()=>{restoreAudioSettings();if(!anyDialog())board.focus({preventScroll:true});});dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog(dialog);}});});
  $('#confirmCancel').onclick=()=>closeDialog($('#confirmDialog'));$('#confirmAccept').onclick=()=>{const action=confirmation;$('#confirmDialog').close();confirmation=null;action?.();};
  $$('[data-settings-tab]').forEach(btn=>btn.onclick=()=>activateSettingsTab(btn.dataset.settingsTab));
  $('#resetKeysBtn').onclick=()=>{draftKeys={...DEFAULT_KEYS};bindingAction=null;renderKeyBindings();};
  $('#resetSoundsBtn').onclick=()=>{draftAudio=A.normalizeConfig();$('#settingsForm').elements.volume.value=draftAudio.volume;$('#volumeValue').textContent=draftAudio.volume+'%';renderSoundLibrary();};
  $('#settingsForm').elements.volume.oninput=event=>{$('#volumeValue').textContent=event.target.value+'%';soundEngine.configure(readDraftAudio());};
  $('#settingsForm').elements.sound.onchange=event=>{soundEngine.configure(readDraftAudio());soundEngine.setEnabled?.(event.target.checked);if(event.target.checked)soundEngine.unlock();};
  $('#settingsForm').onsubmit=event=>{
    event.preventDefault();const form=event.currentTarget,next={...settings,keys:{...draftKeys},audio:readDraftAudio()};for(const key of Object.keys(RANGES))next[key]=Number(form.elements[key].value);for(const key of ['ghost','grid','sound','coach'])next[key]=form.elements[key].checked;next.theme=form.elements.theme.value;
    try{settings=cleanSettings(next,true);}catch(error){toast(error.message);return;}
    configureCoach();if(game.state.status==='ready')freshGame();applyTheme();refreshKeyGuide();persist();closeDialog($('#settingsDialog'));toast('设置已保存。起始等级和锁定延迟从新一局生效。');
  };
  $('#exportBtn').onclick=exportData;$('#importBtn').onclick=()=>$('#importFile').click();$('#importFile').onchange=event=>{importData(event.target.files[0]);event.target.value='';};
  window.addEventListener('pointerdown',unlockAudio,{capture:true,passive:true});
  window.addEventListener('keydown',unlockAudio,{capture:true});
  window.addEventListener('keydown',event=>{
    const editable=event.target.matches('input,select,textarea,[contenteditable=true]');
    if(event.metaKey||event.ctrlKey){
      cancelCoachPress();
      if(event.code==='KeyZ'&&!event.shiftKey&&!editable&&!anyDialog()){event.preventDefault();if(!event.repeat)undoMove();}
      else if(event.code==='Comma'&&!anyDialog()){event.preventDefault();openDialog('settings');}
      else if(['Enter','NumpadEnter'].includes(event.code)&&$('#settingsDialog').open){event.preventDefault();$('#settingsForm').requestSubmit();}
      return;
    }
    if(event.altKey)return;
    if(bindingAction){event.preventDefault();if(event.code==='Escape'){bindingAction=null;renderKeyBindings();return;}
      if(!isBindable(event.code)){toast('这个键用于系统或游戏快捷操作，请换一个键。');return;}
      const duplicate=Object.entries(draftKeys).find(([action,key])=>key===event.code&&action!==bindingAction);if(duplicate){toast('这个键已用于「'+ACTIONS[duplicate[0]]+'」。');return;}
      draftKeys[bindingAction]=event.code;bindingAction=null;renderKeyBindings();return;
    }
    if(anyDialog()){
      const dialog=$$('dialog[open]').at(-1);
      if(event.code==='Tab'){event.preventDefault();focusByTab(dialog,event.shiftKey);return;}
      if(dialog.id==='confirmDialog'){
        if(event.code==='ArrowLeft'||event.code==='ArrowRight'){event.preventDefault();$(event.code==='ArrowLeft'?'#confirmCancel':'#confirmAccept').focus();}
        else if(event.code==='KeyR'&&$('#confirmAccept').textContent==='重新开始'){event.preventDefault();if(!event.repeat)$('#confirmAccept').click();}
      }else if(dialog.id==='settingsDialog'&&event.target.matches('[data-settings-tab]')&&['ArrowLeft','ArrowRight','Home','End'].includes(event.code)){
        event.preventDefault();const tabs=$$('[data-settings-tab]'),index=tabs.indexOf(event.target),next=event.code==='Home'?0:event.code==='End'?tabs.length-1:(index+(event.code==='ArrowRight'?1:-1)+tabs.length)%tabs.length;activateSettingsTab(tabs[next].dataset.settingsTab,true);
      }
      return;
    }
    if(editable)return;
    if(event.code==='Tab'){event.preventDefault();cancelCoachPress();stopAutoplay();if(game.state.status==='running'){pause('menu');render();}focusByTab($('.shell'),event.shiftKey);return;}
    if(['Enter','NumpadEnter'].includes(event.code)&&event.target.closest('.mode-button')){event.preventDefault();startOrResume();return;}
    if(['Enter','NumpadEnter','Space'].includes(event.code)&&event.target.closest('button,a[href]'))return;
    if(event.target.closest('.mode-button')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.code)){
      event.preventDefault();const modes=Object.keys(MODES),direction=['ArrowRight','ArrowDown'].includes(event.code)?1:-1,next=modes[(modes.indexOf(mode)+direction+modes.length)%modes.length];changeMode(next);$(`[data-mode="${next}"]`).focus();return;
    }
    const name=Object.keys(ACTIONS).find(action=>settings.keys[action]===event.code);
    if(name){event.preventDefault();if(!event.repeat)press(name,event.code);return;}
    if(['Escape','KeyP','Enter','NumpadEnter','KeyR','KeyF'].includes(event.code)){event.preventDefault();if(event.repeat)return;
      if(event.code==='Escape'||event.code==='KeyP'){if(game.state.status==='paused')startOrResume();else pause();}
      else if(event.code==='Enter'||event.code==='NumpadEnter'){if(externalChange)location.reload();else if(game.state.status!=='running')startOrResume();}
      else if(event.code==='KeyR')restart();else if(event.code==='KeyF')toggleFullscreen();
      return;
    }
    if(event.repeat)return;
    if(event.code==='KeyS'){event.preventDefault();openDialog('settings');}else if(event.code==='KeyL'){event.preventDefault();openDialog('records');}else if(event.code==='KeyH'){event.preventDefault();openDialog('help');}
    else if(/^Digit[1-5]$/.test(event.code)){event.preventDefault();changeMode(Object.keys(MODES)[Number(event.code.slice(-1))-1]);board.focus({preventScroll:true});}
  });
  window.addEventListener('keyup',event=>release(event.code));
  $$('.touch-controls button').forEach(btn=>{
    btn.addEventListener('pointerdown',event=>{event.preventDefault();btn.setPointerCapture(event.pointerId);press(btn.dataset.action,'pointer'+event.pointerId);});
    for(const name of ['pointerup','pointercancel','lostpointercapture'])btn.addEventListener(name,event=>release('pointer'+event.pointerId));
  });
  document.addEventListener('visibilitychange',()=>{soundEngine.setActive?.(!document.hidden);if(document.hidden)persistAndPause();else requestFrame();});window.addEventListener('focus',()=>{soundEngine.setActive?.(!document.hidden);requestFrame();});window.addEventListener('blur',()=>{soundEngine.setActive?.(false);pause('away');});window.addEventListener('pagehide',()=>{soundEngine.setActive?.(false);persistAndPause();});window.addEventListener('beforeunload',()=>{soundEngine.setActive?.(false);persistAndPause();});
  // A second window must not overwrite a game that was advanced elsewhere.
  window.addEventListener('storage',event=>{if((event.key===STORAGE_KEY||event.key===null)&&event.newValue!==JSON.stringify(data)){
    externalChange=true;stopAutoplay();cancelCoachPress();resetInputs();clearBoardEffects();if(game.state.status==='running')game.pause();clearCoach(true);markDirty();toast('另一窗口更新了进度。请重新载入后继续。');
  }});
  function frame(now){
    frameRequest=null;inFrame=true;
    const dt=lastFrame?Math.max(0,now-lastFrame):0;lastFrame=now;
    if(dt>1500&&game.state.status==='running')pause('away');
    const wasRunning=game.state.status==='running';
    advanceCoachPress(now);
    if(game.state.status==='running'&&!anyDialog()){const elapsed=wasRunning?dt:0;repeatInputs(Math.min(elapsed,100));game.tick(elapsed);drain();if(now-lastPersistAttempt>=1000)persist();}
    syncCoach();advanceAutoplay(now);if(coachRouteDirty)syncInstructions();if(dirty)render(now);else if(effectsAnimating)drawBoard(now);renderClock();
    inFrame=false;
    // Simulation still uses the display clock while playing. Static menus and
    // paused games leave no animation callback behind; events wake one on demand.
    if(game.state.status==='running'||effectsAnimating||(coachPress&&!coachPress.longFired)||autoPlaying)requestFrame();
  }
  loadMode();applyTheme();soundEngine.setActive?.(!document.hidden);refreshKeyGuide();activateSettingsTab('play');render();requestFrame();
  if(loadProblem){$('#saveStatus').textContent='存档读取异常';setTimeout(()=>toast('原存档暂时无法读取，已停止覆盖。可在设置中导入备份恢复。'),300);}
})();
