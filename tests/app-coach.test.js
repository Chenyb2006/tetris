'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const E = require('../engine.js');
const A = require('../audio.js');
const C = require('../coach.js');

const STORAGE_KEY = 'pixelstack.local.v1';
const copy = value => JSON.parse(JSON.stringify(value));
const oldKeys = {left:'ArrowLeft',right:'ArrowRight',rotate:'ArrowUp',ccw:'KeyZ',half:'KeyA',soft:'ArrowDown',hard:'Space',hold:'KeyC',undo:'KeyU'};
function oldSettings(overrides = {}) {
  return {startLevel:1,das:150,arr:35,softInterval:35,lockDelay:500,ghost:true,grid:true,sound:false,audio:A.normalizeConfig(),theme:'paper',lastMode:'marathon',keys:{...oldKeys},...overrides};
}
function stored(settings, records = [], saves = {}) {return {version:1,settings,records,saves};}

// The actual app IIFE runs against a deliberately small DOM. Test hooks are
// injected only in this VM copy; production app.js exposes no private state.
function appHarness(initial, options = {}) {
  const listeners = new Map(), nodes = new Map(), timers = new Map(), animationFrames = new Map();
  let timerId = 0, frameId = 0, now = 1, identity = 0, storageFailures = 0;
  const canvasCalls = [], soundCalls = [], soundStops = [], downloads = [];
  const effectCalls = [], effectInstances = [], eventOrder = [], canvasEvents = [], domWrites = [], storageWrites = [], storageAttempts = [], audioLifecycle = [];
  const epoch=Date.now();
  class BrowserDate extends Date {
    constructor(...args) {super(...(args.length?args:[epoch+now]));}
    static now() {return epoch+now;}
  }
  const contexts = new Map();
  const motionListeners = new Set();
  const motionPreference = {matches:!!options.reducedMotion,addEventListener(name,listener) {if(name==='change')motionListeners.add(listener);},removeEventListener(name,listener) {if(name==='change')motionListeners.delete(listener);}};
  function canvasContext(selector) {
    if(!contexts.has(selector))contexts.set(selector,new Proxy({}, {get(target,key) {return key in target ? target[key] : (...args)=>{canvasCalls.push([key,...args]);canvasEvents.push({selector,method:key,args,time:now});};},set(target,key,value) {target[key]=value;return true;}}));
    return contexts.get(selector);
  }
  const document = {hidden:false,activeElement:null,fullscreenElement:null};
  class Element {
    constructor(name = 'div', selector = '') {
      this.tagName = name.toUpperCase(); this.selector = selector; this.id = selector.startsWith('#') ? selector.slice(1) : '';
      this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.className = ''; this.hidden = false;
      this.disabled = false; this.open = false; this.tabIndex = 0;
      for(const property of ['textContent','innerHTML']) {
        let value='';
        Object.defineProperty(this,property,{get:()=>value,set:next=>{value=next;domWrites.push({selector,property,value:next,time:now});}});
      }
      this.value = ''; this.checked = false; this.width = 200; this.height = 400;
      const classes = new Set();
      this.classList = {add:(...items)=>items.forEach(item=>classes.add(item)),remove:(...items)=>items.forEach(item=>classes.delete(item)),
        contains:item=>classes.has(item),toggle:(item,force)=>{const include = force === undefined ? !classes.has(item) : force; include ? classes.add(item) : classes.delete(item); return include;}};
      this.elements = new Proxy({}, {get(target,key) {return target[key] || (target[key] = new Element('input'));}});
    }
    append(...elements) {for (const element of elements) {element.parentElement = this; this.children.push(element);}}
    appendChild(element) {this.append(element); return element;}
    replaceChildren(...elements) {this.children = []; this.append(...elements);}
    setAttribute(name,value) {this.attributes[name] = String(value);}
    getAttribute(name) {return this.attributes[name];}
    getContext() {return canvasContext(this.selector);}
    focus() {document.activeElement = this;}
    addEventListener(name,listener) {this['on'+name] = listener;}
    showModal() {this.open = true;}
    close() {this.open = false; this.onclose?.({target:this});}
    click() {this.onclick?.({target:this,preventDefault(){}});}
    remove() {}
    scrollIntoView() {}
    getClientRects() {return [{}];}
    getBoundingClientRect() {return {top:0,left:0,right:200,bottom:400};}
    requestSubmit() {this.onsubmit?.({currentTarget:this,preventDefault(){}});}
    matches(selector) {
      if (selector.includes('input') && ['INPUT','SELECT','TEXTAREA'].includes(this.tagName)) return true;
      if (selector === '[data-settings-tab]') return !!this.dataset.settingsTab;
      return false;
    }
    closest(selector) {
      if (selector === 'dialog') return this.tagName === 'DIALOG' ? this : this.parentElement?.closest(selector) || null;
      if (selector === '.mode-button') return this.dataset.mode ? this : this.parentElement?.closest(selector) || null;
      if (selector === 'button,a[href]') return ['BUTTON','A'].includes(this.tagName) ? this : null;
      return null;
    }
    querySelector(selector) {
      const key = this.selector+' '+selector;
      if (!nodes.has(key)) nodes.set(key,new Element('span',key));
      return nodes.get(key);
    }
    querySelectorAll() {return this.children;}
  }
  function node(selector) {
    if (selector.startsWith('[data-mode=')) return node('#modes').children.find(element=>element.dataset.mode===selector.match(/"([^"]+)"/)[1]);
    if (!nodes.has(selector)) {
      const tag = selector.endsWith('Dialog') ? 'dialog' : selector === '#settingsForm' ? 'form' : 'div';
      nodes.set(selector,new Element(tag,selector));
    }
    return nodes.get(selector);
  }
  document.querySelector = node;
  document.querySelectorAll = selector => {
    if (selector === 'dialog' || selector === 'dialog[open]') return ['settings','records','help','confirm'].map(name=>node('#'+name+'Dialog')).filter(element=>selector==='dialog'||element.open);
    if (selector === '#modes button') return node('#modes').children;
    return [];
  };
  document.createElement = name => new Element(name);
  document.body = new Element('body'); document.documentElement = new Element('html');
  document.addEventListener = (event,listener) => addListener('document:'+event,listener);
  function addListener(event, listener) {if (!listeners.has(event)) listeners.set(event,[]); listeners.get(event).push(listener);}
  const storage = new Map(initial ? [[STORAGE_KEY,JSON.stringify(initial)]] : []);
  const controllers = [];
  class FakeController {
    constructor(options) {this.options = options; this.requests = []; this.status = 'idle'; this.cancelCount = 0; controllers.push(this);}
    request(view,key,options) {this.requests.push({view:copy(view),key,options});this.status='thinking';this.worker={};this.options.onStatus?.('thinking');return true;}
    cancel() {this.cancelCount++;this.status='idle';this.worker=null;}
    destroy() {this.cancel();this.status='destroyed';}
    reply(result, key = this.requests.at(-1)?.key) {this.status='idle';this.options.onResult(result,key);}
    fail(message = 'worker unavailable') {this.status='unavailable';this.options.onError(new Error(message),this.requests.at(-1)?.key);}
  }
  class SoundEngine {
    constructor(config){audioLifecycle.push({method:'constructor',config});}
    configure(){audioLifecycle.push({method:'configure'});}
    unlock(){audioLifecycle.push({method:'unlock'});}
    setEnabled(value){audioLifecycle.push({method:'enabled',value});}
    setActive(value){audioLifecycle.push({method:'active',value});}
    play(kind) {soundCalls.push(kind);eventOrder.push({type:'sound',kind});}
    stop(kind) {soundStops.push(kind);}
    preview(){audioLifecycle.push({method:'preview'});}
  }
  const window = {PixelEngine:E,PixelAudio:{...A,SoundEngine},PixelCoachClient:{Controller:FakeController},PixelCoachCore:C,
    addEventListener:addListener,crypto:{randomUUID:()=>`test-${++identity}`},devicePixelRatio:1,
    matchMedia:()=>motionPreference};
  const sandbox = {window,document,console,Date:BrowserDate,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storageAttempts.push({key,value,time:now});if(storageFailures>0){storageFailures--;throw new Error('test storage temporarily unavailable');}storage.set(key,value);storageWrites.push({key,value,time:now});eventOrder.push({type:'storage'});}},
    performance:{now:()=>now},requestAnimationFrame:callback=>{const id=++frameId;animationFrames.set(id,callback);return id;},cancelAnimationFrame:id=>animationFrames.delete(id),
    setTimeout:(callback,delay=0)=>{const id=++timerId;timers.set(id,{callback,at:now+Math.max(0,Number(delay)||0)});return id;},clearTimeout:id=>timers.delete(id),
    getComputedStyle:()=>({getPropertyValue:()=>'#000'}),location:{reload(){}},Blob,
    URL:{createObjectURL(blob){downloads.push(blob);return 'blob:app-test';},revokeObjectURL(){}}};
  // Load the production effects implementation. Instrument its boundary, not
  // its output, so app regressions exercise the real animation lifecycle.
  const effectSource = fs.readFileSync(require.resolve('../effects.js'),'utf8');
  vm.runInNewContext(effectSource+'\nwindow.PixelEffects=globalThis.PixelEffects||window.PixelEffects;',sandbox,{filename:'effects.js'});
  const RealBoardEffects = window.PixelEffects.BoardEffects;
  class ObservedBoardEffects extends RealBoardEffects {
    constructor(...args) {super(...args);effectInstances.push(this);}
    consume(events, time) {
      if(events.length)eventOrder.push({type:'effects',events:copy(events)});
      effectCalls.push({method:'consume',events:copy(events),time});
      return super.consume(events,time);
    }
    draw(context,time) {const active=super.draw(context,time);effectCalls.push({method:'draw',time,active});return active;}
    clear() {effectCalls.push({method:'clear'});return super.clear();}
  }
  window.PixelEffects={...window.PixelEffects,BoardEffects:ObservedBoardEffects};
  const source = fs.readFileSync(require.resolve('../app.js'),'utf8');
  const hooks = `window.__test={get settings(){return settings},get game(){return game},get session(){return session},get data(){return data},get coachResult(){return coachResult},get coachKey(){return coachKey},get effectsAnimating(){return effectsAnimating},cleanSettings,persist,render,record,loadMode,updateBest,drawBoard};`;
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/,hooks+'})();'),sandbox,{filename:'app.js'});
  const api = window.__test;
  function keyEvent(type,code,extra={}) {
    const event={code,repeat:false,metaKey:false,ctrlKey:false,altKey:false,shiftKey:false,target:node('#board'),preventDefault(){},...extra};
    for(const listener of listeners.get(type)||[])listener(event);
  }
  function runTimers(target) {
    let count=0;
    while(true) {
      const next=[...timers.entries()].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!next)break;
      assert.ok(++count<10000,'timers eventually yield to the browser');
      const [id,timer]=next;timers.delete(id);now=Math.max(now,timer.at);timer.callback();
    }
    now=target;
  }
  function tick(ms=16){
    runTimers(now+ms);
    // RAF is one shot. A request made by a RAF callback belongs to the next
    // browser frame, while a timer may request the upcoming frame.
    const batch=[...animationFrames.entries()];
    for(const [id,callback]of batch)if(animationFrames.delete(id))callback(now);
  }
  return {window,document,api,nodes,storage,controllers,canvasCalls,canvasEvents,domWrites,storageWrites,storageAttempts,audioLifecycle,soundCalls,soundStops,downloads,node,effectCalls,effectInstances,eventOrder,
    key(code,extra={}) {keyEvent('keydown',code,extra);keyEvent('keyup',code,extra);},
    holdKey(code,extra={}) {keyEvent('keydown',code,extra);},
    releaseKey(code,extra={}) {keyEvent('keyup',code,extra);},
    tick,
    advance(ms,step=16){while(ms>0){const elapsed=Math.min(ms,step);tick(elapsed);ms-=elapsed;}},
    advanceTime(ms){now+=ms;},
    get pendingFrames(){return animationFrames.size;},
    get pendingTimers(){return timers.size;},
    setReducedMotion(matches){motionPreference.matches=matches;for(const listener of motionListeners)listener({matches});},
    failStorageWrites(count=1){storageFailures=count;},
    emit(name,extra={}){for(const listener of listeners.get(name)||[])listener({type:name,...extra});},
    get now(){return now;},
    stored() {return JSON.parse(storage.get(STORAGE_KEY));},
    flushTimers() {const pending=[...timers.values()];timers.clear();pending.forEach(timer=>timer.callback());}
  };
}
function start(harness) {harness.key('Enter');harness.tick();assert.equal(harness.api.game.state.status,'running');}
function enable(harness) {harness.key(harness.api.settings.keys.coach);harness.tick();}
function coachRequest(harness) {return harness.controllers.at(-1)?.requests.at(-1);}
function recommendation(request) {
  assert.ok(request, 'a public position was sent to the coach');
  return C.analyze(request.view,{budgetMs:0,maxDepth:1});
}
function holdRecommendation(request) {
  const view=copy(request.view),type=view.holdType||view.queue[0];
  if(!view.holdType)view.queue.shift();
  view.holdType=view.active.type;view.canHold=false;
  view.active={type,x:3,y:E.HIDDEN_ROWS-1,rotation:0};view.lastAction=null;view.lastKick=-1;
  const result=C.analyze(view,{budgetMs:0,maxDepth:1});
  assert.ok(result.move,'the held piece has a legal placement');
  result.move.hold=true;result.move.path.unshift('hold');
  return result;
}
function fixedTarget(harness) {
  const move=harness.api.coachResult?.move;
  return move ? copy({piece:move.piece,cells:move.cells}) : null;
}
async function importBackup(harness,backup) {
  const text=JSON.stringify(backup);
  harness.node('#importFile').onchange({target:{files:[{size:text.length,text:()=>Promise.resolve(text)}],value:'backup.json'}});
  await Promise.resolve();await Promise.resolve();
  assert.equal(harness.node('#confirmDialog').open,true,'a valid backup reaches restore confirmation');
  harness.node('#confirmAccept').click();harness.tick();
}
function autoplayState(harness){return harness.window.PixelStack.getAutoplayState();}
function longCoachPress(harness,code=harness.api.settings.keys.coach){
  harness.holdKey(code);harness.advance(650);harness.releaseKey(code);harness.tick();
}
function advanceUntil(harness,predicate,maximumMs=4000){
  for(let elapsed=0;elapsed<=maximumMs;elapsed+=16){if(predicate())return;harness.tick(16);}
  assert.fail('expected game progress within '+maximumMs+' ms');
}
function explicitRecommendation(request,piece,path,hold=false){
  const move={piece,cells:E.getCells(piece),hold,path};
  const result=C.applyPath(request.view,move);
  assert.equal(result.valid,true,'the fake worker supplies a genuinely reachable placement');
  return {move,metrics:{...C.inspect(result.board),spin:result.clear.spin},depth:1,knownOnly:true};
}

// These assertions cover user-visible behavior, persistence, and the public
// information boundary between the game and the independent search worker.
test('coach defaults off and older key mappings, including an existing G binding, migrate intact', () => {
  const fresh = appHarness();
  assert.equal(fresh.api.settings.coach,false);
  assert.equal(fresh.api.settings.keys.coach,'KeyG');
  start(fresh);
  assert.equal(coachRequest(fresh),undefined);
  const migrated = appHarness(stored(oldSettings({keys:{...oldKeys,left:'KeyG'}})));
  assert.equal(migrated.api.settings.coach,false);
  assert.equal(migrated.api.settings.keys.left,'KeyG');
  assert.ok(migrated.api.settings.keys.coach);
  assert.notEqual(migrated.api.settings.keys.coach,'KeyG');
  start(migrated);
  const x = migrated.api.game.state.active.x;
  migrated.key('KeyG');
  assert.equal(migrated.api.game.state.active.x,x-1);
  assert.equal(migrated.api.settings.coach,false);
});

test('G toggles coach with keyboard, persists the preference, and custom coach keys work', () => {
  const h = appHarness(); start(h); enable(h);
  assert.equal(h.api.settings.coach,true);
  assert.ok(coachRequest(h));
  assert.equal(h.stored().settings.coach,true);
  h.key('KeyG'); h.tick();
  assert.equal(h.api.settings.coach,false);
  assert.ok(h.controllers.at(-1).cancelCount>0);
  const custom = appHarness(stored({...oldSettings(),coach:false,keys:{...oldKeys,coach:'KeyV'}}));
  start(custom); custom.key('KeyG'); custom.tick();
  assert.equal(custom.api.settings.coach,false);
  custom.key('KeyV'); custom.tick();
  assert.equal(custom.api.settings.coach,true);
  assert.ok(coachRequest(custom));
});

test('worker receives only the public board and visible queue, with no hidden random or undo state', () => {
  for (const mode of ['marathon','classic']) {
    const h = appHarness(stored(oldSettings({lastMode:mode}))); start(h); enable(h);
    const {view} = coachRequest(h);
    assert.equal(view.mode,mode);
    assert.equal(view.queue.length,mode==='classic'?1:5);
    assert.deepEqual(view.queue,h.api.game.state.queue.slice(0,mode==='classic'?1:5));
    for (const key of ['seed','rng','rngState','random','bag','undoHistory','turnStart']) assert.equal(Object.hasOwn(view,key),false,key+' stays private');
    assert.equal(JSON.stringify(view).includes('undoHistory'),false);
    assert.equal(JSON.stringify(view).includes('rngState'),false);
    assert.deepEqual(view.board,h.api.game.state.board);
    assert.notEqual(view.board,h.api.game.state.board);
  }
});

test('a result returned after movement, rotation, or soft drop belongs to the same piece', () => {
  for (const key of ['ArrowLeft','ArrowRight','ArrowUp','KeyZ','KeyA','ArrowDown']) {
    const h=appHarness();start(h);enable(h);
    const request=coachRequest(h),result=recommendation(request),controller=h.controllers.at(-1);
    h.key(key);h.tick();controller.reply(result,request.key);h.tick();h.api.persist();
    assert.equal(controller.requests.length,1,key+' must not trigger another analysis');
    assert.ok(h.node('#coachPath').textContent,key+' keeps its original target');
    assert.equal(h.node('#coachPath').hidden,false);
    assert.equal(h.api.session.coached,true);
    assert.equal(h.stored().saves.marathon.coached,true);
  }
});

test('turning coach off hides its in-flight result without marking practice', () => {
  const h=appHarness();start(h);enable(h);
  const request=coachRequest(h),result=recommendation(request),controller=h.controllers.at(-1);
  h.key('KeyG');controller.reply(result,request.key);h.tick();h.api.persist();
  assert.equal(h.node('#coachPath').textContent,'');
  assert.equal(h.node('#coachPath').hidden,true);
  assert.equal(!!h.api.session.coached,false);
  assert.equal(!!h.stored().saves.marathon.coached,false);
});

test('only a displayed valid recommendation marks the game coached, and that flag survives off, restore, and undo', () => {
  const h=appHarness();start(h);enable(h);
  assert.equal(!!h.api.session.coached,false);
  const request=coachRequest(h),controller=h.controllers.at(-1);
  controller.reply(recommendation(request),request.key);h.tick();h.api.persist();
  assert.equal(h.api.session.coached,true);
  assert.equal(h.api.session.assisted,true);
  assert.equal(h.stored().saves.marathon.coached,true);
  h.key('KeyG');h.key('Space');h.tick();h.key('KeyU');h.tick();h.api.persist();
  assert.equal(h.api.session.coached,true);
  assert.equal(h.stored().saves.marathon.coached,true);
  const restored=appHarness(h.stored());
  assert.equal(restored.api.game.state.status,'paused');
  assert.equal(restored.api.session.coached,true);
  assert.equal(restored.api.session.assisted,true);
  start(restored);restored.key('Space');restored.key('KeyU');restored.api.persist();
  assert.equal(restored.api.session.coached,true);
  assert.equal(restored.stored().saves.marathon.coached,true);
});

test('pausing hides the recommendation and resuming restores the same cached target', () => {
  const h=appHarness();start(h);enable(h);
  const controller=h.controllers.at(-1),request=coachRequest(h);
  controller.reply(recommendation(request),request.key);h.tick();
  assert.ok(h.node('#coachPath').textContent);
  const path=h.node('#coachPath').textContent,before=controller.cancelCount,requests=controller.requests.length;
  h.key('Escape');h.tick();
  assert.equal(h.api.game.state.status,'paused');
  assert.equal(controller.cancelCount,before);
  assert.equal(h.node('#coachPath').textContent,'');
  assert.equal(h.node('#coachPath').hidden,true);
  assert.equal(h.api.session.coached,true);
  h.key('Enter');h.tick();
  assert.equal(controller.requests.length,requests);
  assert.equal(h.node('#coachPath').textContent,path);
  assert.equal(h.node('#coachPath').hidden,false);
});

test('an in-flight result is cached during pause and shown on resume without another analysis', () => {
  const h=appHarness();start(h);enable(h);
  const controller=h.controllers.at(-1),request=coachRequest(h),before=controller.cancelCount;
  h.key('Escape');h.tick();controller.reply(recommendation(request),request.key);h.tick();h.api.persist();
  assert.equal(controller.cancelCount,before);
  assert.equal(controller.requests.length,1);
  assert.equal(h.node('#coachPath').textContent,'');
  assert.equal(!!h.api.session.coached,false);
  assert.equal(!!h.stored().saves.marathon.coached,false);
  h.key('Enter');h.tick();h.api.persist();
  assert.equal(controller.requests.length,1);
  assert.equal(h.node('#coachPath').hidden,false);
  assert.ok(h.node('#coachPath').textContent);
  assert.equal(h.api.session.coached,true);
});

test('turning coach off and back on reuses an already computed recommendation for the same piece', () => {
  const h=appHarness();start(h);enable(h);
  const controller=h.controllers.at(-1),request=coachRequest(h);
  controller.reply(recommendation(request),request.key);h.tick();
  const target=fixedTarget(h);
  h.key('KeyG');h.tick();
  assert.equal(h.node('#coachPath').hidden,true);
  assert.equal(h.node('#coachPath').textContent,'');
  h.key('ArrowLeft');h.tick();h.key('KeyG');h.tick();
  assert.equal(controller.requests.length,1);
  assert.equal(h.node('#coachPath').hidden,false);
  assert.deepEqual(fixedTarget(h),target);
  assert.ok(h.node('#coachPath').textContent);
});

test('coached records remain practice and never become standard personal bests', () => {
  const record=(id,score,extra={})=>({id,mode:'marathon',outcome:'over',score,lines:0,elapsedMs:1000,pieces:1,tetrises:0,tspins:0,endedAt:Date.now(),...extra});
  const h=appHarness(stored(oldSettings(),[record('ordinary',10),record('coach-only',900,{coached:true})]));
  assert.equal(h.node('#personalBest').textContent,'10');
  start(h);enable(h);const request=coachRequest(h);
  h.controllers.at(-1).reply(recommendation(request),request.key);h.tick();
  h.api.game.state.score=1000;h.api.game.state.pieces=1;h.api.record('over');
  const saved=h.stored().records.find(item=>item.id===h.api.session.id);
  assert.equal(saved.coached,true);
  assert.equal(saved.assisted,true);
  assert.equal(h.node('#personalBest').textContent,'10');
});


test('strict backup import accepts legacy settings and preserves G when it belongs to another action', async () => {
  const h=appHarness();
  const legacy=stored(oldSettings({keys:{...oldKeys,rotate:'KeyG'}}));
  const text=JSON.stringify(legacy);
  h.node('#importFile').onchange({target:{files:[{size:text.length,text:()=>Promise.resolve(text)}],value:'legacy.json'}});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.node('#confirmDialog').open,true);
  h.node('#confirmAccept').click();
  assert.equal(h.node('#confirmDialog').open,false);
  assert.equal(h.api.settings.coach,false);
  assert.equal(h.api.settings.keys.rotate,'KeyG');
  assert.notEqual(h.api.settings.keys.coach,'KeyG');
  assert.equal(h.stored().settings.keys.rotate,'KeyG');
});

test('moving and rotating keeps one fixed recommendation without another worker request', () => {
  for (const primeMovement of [false,true]) {
    const h=appHarness();start(h);
    if(primeMovement){h.key('ArrowLeft');h.key('ArrowRight');h.tick();}
    enable(h);
    const request=coachRequest(h),controller=h.controllers.at(-1);
    controller.reply(recommendation(request),request.key);h.tick();
    const path=h.node('#coachPath').textContent,target=fixedTarget(h),requests=controller.requests.length;
    assert.ok(path);
    for(const key of ['ArrowLeft','ArrowLeft','ArrowRight','ArrowUp','KeyZ','KeyA','ArrowDown']){
      h.key(key);h.tick();
      assert.equal(controller.requests.length,requests,key);
      assert.deepEqual(fixedTarget(h),target,key+' retains its placement while the operation path may update');
      assert.ok(h.node('#coachPath').textContent,key+' keeps an actionable hint');
      assert.equal(h.node('#coachPath').hidden,false,key);
    }
  }
});

test('cancelled and prior-session callbacks cannot mark a fresh game as coached', () => {
  const h=appHarness();start(h);enable(h);
  const old=coachRequest(h),controller=h.controllers.at(-1),result=recommendation(old);
  h.key('KeyG');
  controller.reply(result,old.key);h.tick();
  assert.equal(!!h.api.session.coached,false);
  h.key('KeyG');h.tick();
  const pending=coachRequest(h),oldSession=h.api.session.id;
  h.key('KeyR');h.node('#confirmAccept').click();h.tick();
  assert.notEqual(h.api.session.id,oldSession);
  assert.equal(h.api.game.state.status,'running');
  controller.reply(recommendation(pending),pending.key);h.tick();h.api.persist();
  assert.equal(!!h.api.session.coached,false);
  assert.equal(!!h.stored().saves.marathon.coached,false);
  assert.equal(h.node('#coachPath').textContent,'');
});

test('a completed search without a valid move and a worker failure never mark practice', () => {
  for(const failure of [false,true]){
    const h=appHarness();start(h);enable(h);
    const controller=h.controllers.at(-1);
    if(failure)controller.fail();else controller.reply({move:null,reason:'No move'});
    h.tick();h.api.persist();
    assert.equal(!!h.api.session.coached,false);
    assert.equal(!!h.api.session.assisted,false);
    assert.equal(!!h.stored().saves.marathon.coached,false);
    assert.equal(h.node('#coachPath').textContent,'');
  }
});

test('receiving a result alone does not mark practice before the next rendered frame', () => {
  for(const cancelBeforeRender of [false,true]){
    const h=appHarness();start(h);enable(h);
    const request=coachRequest(h),controller=h.controllers.at(-1);
    controller.reply(recommendation(request),request.key);
    assert.equal(!!h.api.session.coached,false);
    assert.equal(!!h.stored().saves.marathon.coached,false);
    if(cancelBeforeRender)h.key('KeyG');
    h.tick();h.api.persist();
    assert.equal(!!h.api.session.coached,!cancelBeforeRender);
    assert.equal(!!h.stored().saves.marathon.coached,!cancelBeforeRender);
  }
});

test('natural gravity keeps the fixed target and accepts a late same-piece result', () => {
  for(const resultBeforeFall of [false,true]){
    const h=appHarness();start(h);enable(h);
    const request=coachRequest(h),controller=h.controllers.at(-1),result=recommendation(request);
    const originalY=h.api.game.state.active.y;
    if(resultBeforeFall){controller.reply(result,request.key);h.tick();}
    const priorRequests=controller.requests.length;
    h.tick(E.gravityMs(h.api.game.state.level,'marathon'));
    assert.ok(h.api.game.state.active.y>originalY);
    assert.equal(controller.requests.length,priorRequests);
    if(!resultBeforeFall)controller.reply(result,request.key);
    h.tick();
    assert.ok(h.node('#coachPath').textContent);
    assert.equal(h.node('#coachPath').hidden,false);
    assert.equal(h.api.session.coached,true);
  }
});

test('manual hold without a cached hold plan and spawning a new piece reject a late recommendation', () => {
  for(const key of ['KeyC','Space']){
    const h=appHarness();start(h);enable(h);
    const request=coachRequest(h),controller=h.controllers.at(-1),result=recommendation(request);
    h.key(key);h.tick();
    assert.equal(controller.requests.length,2,key+' requests a new target');
    assert.notEqual(coachRequest(h).key,request.key);
    controller.reply(result,request.key);h.tick();
    assert.equal(h.node('#coachPath').textContent,'',key);
    assert.equal(!!h.api.session.coached,false,key);
    const next=coachRequest(h);controller.reply(recommendation(next),next.key);h.tick();
    assert.ok(h.node('#coachPath').textContent,key+' can display the next piece target');
    assert.equal(h.api.session.coached,true);
  }
});

test('following a recommended empty or occupied hold keeps its target and does not ask for another search', () => {
  for(const heldType of [null,'I']){
    const h=appHarness();start(h);h.api.game.state.holdType=heldType;enable(h);
    const request=coachRequest(h),controller=h.controllers.at(-1),result=holdRecommendation(request);
    controller.reply(result,request.key);h.tick();
    const target=fixedTarget(h),oldKey=h.api.coachKey,requests=controller.requests.length;
    assert.equal(h.api.coachResult.move.hold,true);
    h.key('KeyC');h.tick();
    assert.equal(h.api.game.state.active.type,result.move.piece.type);
    assert.equal(controller.requests.length,requests,'expected hold should reuse the original search');
    assert.deepEqual(fixedTarget(h),target,'the pre-hold target remains exact');
    assert.equal(h.api.coachResult.move.hold,false);
    assert.equal(h.api.coachResult.move.path.includes('hold'),false);
    assert.notEqual(h.api.coachKey,oldKey,'old callbacks lose authority after the exchange');
    assert.ok(h.node('#coachPath').textContent);
    const carried=fixedTarget(h);
    controller.reply({...result,move:null},request.key);h.tick();
    controller.options.onError(new Error('late pre-hold failure'),request.key);h.tick();
    assert.deepEqual(fixedTarget(h),carried,'late callbacks cannot erase the carried plan');
    assert.equal(controller.requests.length,requests);
  }
});

test('manual hold after a non-hold recommendation searches for the newly chosen piece', () => {
  const h=appHarness();start(h);enable(h);
  const request=coachRequest(h),controller=h.controllers.at(-1),result=C.analyze({...request.view,canHold:false},{budgetMs:0,maxDepth:1});
  assert.equal(result.move.hold,false);
  controller.reply(result,request.key);h.tick();
  h.key('KeyC');h.tick();
  assert.equal(controller.requests.length,2);
  assert.notEqual(coachRequest(h).key,request.key);
  assert.equal(fixedTarget(h),null);
  const current=coachRequest(h);controller.reply(recommendation(current),current.key);h.tick();
  assert.ok(fixedTarget(h));
});

test('a recommended hold is discarded when its public board or queue no longer matches', () => {
  for(const mutation of ['board','queue']){
    const h=appHarness();start(h);enable(h);
    const request=coachRequest(h),controller=h.controllers.at(-1),result=holdRecommendation(request);
    controller.reply(result,request.key);h.tick();
    if(mutation==='board')h.api.game.state.board[23][0]='J';
    else h.api.game.state.queue[1]=h.api.game.state.queue[1]==='Z'?'S':'Z';
    h.key('KeyC');h.tick();
    assert.equal(controller.requests.length,2,mutation+' mismatch requires a new search');
    assert.equal(fixedTarget(h),null,mutation+' mismatch must hide the old target');
  }
});

test('hold still requests a new target when the exchanged piece has the same shape', () => {
  const h=appHarness();start(h);h.api.game.state.holdType=h.api.game.state.active.type;enable(h);
  const request=coachRequest(h),controller=h.controllers.at(-1),type=h.api.game.state.active.type;
  h.key('KeyC');h.tick();
  assert.equal(h.api.game.state.active.type,type);
  assert.equal(controller.requests.length,2);
  assert.notEqual(coachRequest(h).key,request.key);
  controller.reply(recommendation(request),request.key);h.tick();
  assert.equal(h.node('#coachPath').textContent,'');
  assert.equal(!!h.api.session.coached,false);
});

test('a previous piece worker error cannot clear the current piece recommendation', () => {
  const h=appHarness();start(h);enable(h);
  const controller=h.controllers.at(-1),previous=coachRequest(h);
  h.key('Space');h.tick();const current=coachRequest(h);
  controller.reply(recommendation(current),current.key);h.tick();
  const label=h.node('#coachPath').textContent,reason=h.node('#coachReason').textContent;
  assert.ok(label);
  controller.options.onError(new Error('late failure'),previous.key);h.tick();
  assert.equal(h.node('#coachPath').textContent,label);
  assert.equal(h.node('#coachReason').textContent,reason);
  assert.equal(h.node('#coachPath').hidden,false);
});

test('undo restores a fresh target identity and rejects results for the undone position', () => {
  const h=appHarness();start(h);enable(h);
  const controller=h.controllers.at(-1),first=coachRequest(h);
  h.key('Space');h.tick();const placed=coachRequest(h);
  h.key('KeyU');h.tick();const restored=coachRequest(h);
  assert.equal(controller.requests.length,3);
  assert.notEqual(restored.key,placed.key);
  assert.notEqual(restored.key,first.key);
  for(const stale of [first,placed]){
    controller.reply(recommendation(stale),stale.key);h.tick();
    assert.equal(h.node('#coachPath').textContent,'');
    assert.equal(!!h.api.session.coached,false);
  }
  controller.reply(recommendation(restored),restored.key);h.tick();
  assert.ok(h.node('#coachPath').textContent);
  assert.equal(h.api.session.coached,true);
});

test('switching modes rejects a previous-mode result and computes one target for the selected mode', () => {
  const h=appHarness();start(h);enable(h);
  const controller=h.controllers.at(-1),request=coachRequest(h);
  h.node('[data-mode="zen"]').click();h.tick();start(h);
  assert.equal(h.api.game.state.mode,'zen');
  const current=coachRequest(h);
  assert.equal(controller.requests.length,2);
  assert.notEqual(current.key,request.key);
  controller.reply(recommendation(request),request.key);h.tick();
  assert.equal(h.node('#coachPath').textContent,'');
  assert.equal(!!h.api.session.coached,false);
  controller.reply(recommendation(current),current.key);h.tick();
  assert.ok(h.node('#coachPath').textContent);
});

test('a fixed target displays actual operation keys without a prose explanation', () => {
  const h=appHarness();start(h);enable(h);
  const request=coachRequest(h),controller=h.controllers.at(-1),result=recommendation(request);
  controller.reply(result,request.key);h.tick();
  const target=fixedTarget(h),label=h.node('#coachPath').textContent;
  assert.ok(label.includes('空格'),'the drop control is shown');
  assert.equal(h.node('#coachReason').textContent.includes(result.reason),false,'search prose is omitted');
  h.key('ArrowLeft');h.tick();
  assert.deepEqual(fixedTarget(h),target,'position changes cannot replace the target');
  assert.ok(h.node('#coachPath').textContent,'the operation hint stays available');
});

test('operation hints follow the configured hold and drop keys', () => {
  const keys={...oldKeys,hold:'KeyB',hard:'KeyV',coach:'KeyG'};
  const h=appHarness(stored({...oldSettings(),keys}));start(h);enable(h);
  const request=coachRequest(h),controller=h.controllers.at(-1),result=holdRecommendation(request);
  controller.reply(result,request.key);h.tick();
  assert.ok(h.node('#coachPath').textContent.includes('B'),'configured hold key is shown');
  assert.ok(h.node('#coachPath').textContent.includes('V'),'configured hard-drop key is shown');
  assert.equal(h.node('#coachPath').textContent.includes('空格'),false);
  h.key('KeyB');h.tick();
  assert.equal(h.api.game.state.active.type,result.move.piece.type);
  assert.equal(controller.requests.length,1);
  assert.ok(h.node('#coachPath').textContent.includes('V'));
});

test('zen soft drop at a contact surface does not replay falling or contact sounds', () => {
  const h=appHarness(stored(oldSettings({lastMode:'zen',sound:true})));start(h);
  for(let count=0;count<30;count++){h.key('ArrowDown');h.tick(40);}
  const y=h.api.game.state.active.y,score=h.api.game.state.score,pieces=h.api.game.state.pieces;
  assert.equal(h.api.game.softDrop(),false,'the piece is resting on the contact surface');
  h.soundCalls.length=0;h.soundStops.length=0;
  h.holdKey('ArrowDown');
  for(let count=0;count<60;count++)h.tick(40);
  h.releaseKey('ArrowDown');
  assert.equal(h.api.game.state.active.y,y);
  assert.equal(h.api.game.state.score,score);
  assert.equal(h.api.game.state.pieces,pieces);
  assert.deepEqual(h.soundCalls,[]);
  assert.ok(h.soundStops.length>0,'remaining soft-drop tails are stopped at the contact surface');
  assert.ok(h.soundStops.every(kind=>kind==='softdrop'),'other game sounds are left playing');
  assert.equal(h.api.game.state.status,'running');
  h.key('Space');h.tick();
  assert.ok(h.soundCalls.includes('harddrop'),'hard drop still plays normally');
  assert.ok(h.soundStops.every(kind=>kind==='softdrop'));
});

test('search budgets shrink with gravity and lock delay while zen retains its thinking budget', () => {
  const budget=(mode,startLevel,lockDelay=500)=>{
    const h=appHarness(stored(oldSettings({lastMode:mode,startLevel,lockDelay})));
    start(h);enable(h);
    return coachRequest(h).options.budgetMs;
  };
  const normal=budget('marathon',1),fast=budget('marathon',20),classic=budget('classic',20);
  assert.equal(normal,85);
  assert.ok(fast>=3&&fast<normal);
  assert.ok(classic>=3&&classic<normal);
  assert.ok(budget('marathon',1,100)<=25);
  assert.equal(budget('zen',20,100),85);
});

function ordinaryProgress() {
  const modes=['marathon','sprint','ultra','zen','classic'],saves={};
  for(const [index,mode] of modes.entries()) {
    const game=new E.Game({mode,seed:80+index});game.start();
    if(mode!=='classic')game.hold();
    game.move(index%2?1:-1);game.hardDrop();game.tick(250);game.pause();game.drainEvents();
    saves[mode]={id:'preserved-'+mode,createdAt:1000,snapshot:game.serialize(),updatedAt:2000};
  }
  return saves;
}

function retiredModeBackup() {
  const records=[
    {id:'standard',mode:'marathon',outcome:'over',score:1200,lines:4,elapsedMs:9000,pieces:8,tetrises:1,tspins:0,endedAt:Date.now()},
    {id:'coached',mode:'sprint',outcome:'won',score:2300,lines:40,elapsedMs:80000,pieces:100,tetrises:7,tspins:2,endedAt:Date.now(),coached:true,assisted:true}
  ];
  const backup=stored(oldSettings({lastMode:'training',coach:true,keys:{...oldKeys,left:'Digit6'}}),records,ordinaryProgress());
  // Removed course data is deliberately malformed: the reader must ignore it
  // instead of making otherwise valid ordinary progress impossible to import.
  backup.training={selected:'removed-lesson',completed:{anything:{bad:true}},showHints:true};
  backup.saves.training={id:'obsolete-course',snapshot:{noLongerSupported:true}};
  return backup;
}

test('only the five ordinary modes are exposed and shortcut 6 has no mode action', () => {
  const h=appHarness();
  assert.deepEqual(h.node('#modes').children.map(button=>button.dataset.mode),['marathon','sprint','ultra','zen','classic']);
  start(h);const current=h.api.game;
  h.key('Digit6');h.tick();
  assert.equal(h.api.game,current);
  assert.equal(h.api.game.state.mode,'marathon');
  assert.ok([...h.nodes.values()].filter(element=>element.tagName==='DIALOG').every(element=>!element.open));
  for(const [index,mode] of ['marathon','sprint','ultra','zen','classic'].entries()) {
    h.key('Digit'+(index+1));h.tick();assert.equal(h.api.game.state.mode,mode);
  }
});

test('reopening the retired course mode falls back safely and preserves every ordinary save', () => {
  const backup=retiredModeBackup(),h=appHarness(backup);
  assert.equal(h.api.settings.lastMode,'marathon');
  assert.equal(h.api.game.state.mode,'marathon');
  assert.equal(h.api.session.id,'preserved-marathon');
  assert.equal(h.api.game.state.status,'paused');
  assert.equal(h.api.settings.keys.left,'Digit6');
  assert.equal(h.api.settings.coach,true);
  assert.deepEqual(copy(h.api.data.records),backup.records);
  assert.equal(Object.hasOwn(h.api.data,'training'),false);
  assert.equal(Object.hasOwn(h.api.data.saves,'training'),false);
  for(const mode of Object.keys(backup.saves).filter(mode=>mode!=='training')) {
    assert.deepEqual(copy(h.api.data.saves[mode].snapshot),backup.saves[mode].snapshot,mode);
  }
  h.api.persist();
  const rewritten=h.stored();
  assert.equal(rewritten.settings.lastMode,'marathon');
  assert.equal(Object.hasOwn(rewritten,'training'),false);
  assert.equal(Object.hasOwn(rewritten.saves,'training'),false);
  assert.deepEqual(rewritten.records,backup.records);
  start(h);const x=h.api.game.state.active.x;h.key('Digit6');h.tick();
  assert.equal(h.api.game.state.active.x,x-1,'a previously customized 6 binding remains usable');
});

test('strict import of an old course backup keeps records, keys, flags and all ordinary snapshots', async () => {
  const backup=retiredModeBackup(),h=appHarness();
  // A retired record, if present in an older backup, is ignored independently.
  backup.records.push({id:'obsolete-course-record',mode:'training'});
  await importBackup(h,backup);
  assert.equal(h.api.settings.lastMode,'marathon');
  assert.equal(h.api.game.state.mode,'marathon');
  assert.equal(h.api.session.id,'preserved-marathon');
  assert.deepEqual(copy(h.api.data.records),backup.records.slice(0,2));
  assert.equal(h.api.settings.keys.left,'Digit6');
  assert.equal(h.api.settings.coach,true);
  for(const mode of ['marathon','sprint','ultra','zen','classic'])assert.deepEqual(h.stored().saves[mode].snapshot,backup.saves[mode].snapshot,mode);
  h.node('#exportBtn').click();const exported=JSON.parse(await h.downloads.at(-1).text());
  assert.equal(Object.hasOwn(exported,'training'),false);
  assert.equal(Object.hasOwn(exported.saves,'training'),false);
  assert.deepEqual(exported.records,backup.records.slice(0,2));
  assert.throws(()=>h.api.cleanSettings(oldSettings({lastMode:'unrecognized'}),true),/游戏模式无效/,'other invalid modes still fail validation');
});

test('legacy backups without course fields restore ordinary progress without additional dependencies', async () => {
  const saves=ordinaryProgress(),legacy=stored(oldSettings({lastMode:'sprint'}),[],saves),h=appHarness();
  assert.equal(h.window.PixelTraining,undefined);
  await importBackup(h,legacy);
  assert.equal(h.api.game.state.mode,'sprint');
  assert.equal(h.api.session.id,'preserved-sprint');
  for(const mode of Object.keys(saves))assert.deepEqual(h.stored().saves[mode].snapshot,saves[mode].snapshot,mode);
  assert.equal(Object.hasOwn(h.stored(),'training'),false);
});

test('a coach press below 650 ms toggles only hints; a held press toggles autoplay once without an extra release action',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));
  h.holdKey('KeyG');h.advance(649);
  assert.equal(autoplayState(h).active,false);assert.equal(h.api.settings.coach,false);
  h.releaseKey('KeyG');h.tick();
  assert.equal(h.api.settings.coach,true);assert.equal(autoplayState(h).active,false);
  const preference=h.api.settings.coach;
  h.holdKey('KeyG');h.advance(400);h.holdKey('KeyG',{repeat:true});h.advance(250);
  assert.equal(autoplayState(h).active,true,'elapsed hold time comes from RAF rather than OS repeat');
  assert.equal(h.api.game.state.status,'running','a long press starts the ready game');
  h.advance(900);h.holdKey('KeyG',{repeat:true});
  assert.equal(autoplayState(h).active,true,'holding longer cannot toggle repeatedly');
  h.releaseKey('KeyG');h.tick();
  assert.equal(h.api.settings.coach,preference,'long-press release never toggles the short-press preference');
  longCoachPress(h);
  assert.equal(autoplayState(h).active,false);
  assert.equal(h.api.settings.coach,preference);
});

test('long press uses the configured coach key, respects an existing G binding and resumes a paused game',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen',keys:{...oldKeys,left:'KeyG',coach:'KeyV'}})));start(h);
  h.holdKey('KeyG');h.advance(700);h.releaseKey('KeyG');
  assert.equal(autoplayState(h).active,false,'G remains a normal movement key when rebound');
  h.key('Escape');h.tick();assert.equal(h.api.game.state.status,'paused');
  longCoachPress(h,'KeyV');
  assert.equal(autoplayState(h).active,true);assert.equal(h.api.game.state.status,'running');
  assert.equal(h.api.settings.coach,false,'autoplay does not silently alter the saved hint preference');
});

test('a physically long key press is still recognized on release when animation frames were delayed',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));
  h.holdKey('KeyG');h.advanceTime(700);h.releaseKey('KeyG');h.tick();
  assert.equal(autoplayState(h).active,true);
  assert.equal(h.api.game.state.status,'running');
  assert.equal(h.api.settings.coach,false,'a delayed RAF cannot turn a long press into a short hint toggle');
  h.holdKey('KeyG');h.advanceTime(700);h.releaseKey('KeyG');h.tick();
  assert.equal(autoplayState(h).active,false);
});

test('blur, pause and dialogs cancel an unfinished coach hold instead of firing after focus changes',()=>{
  const interruptions=[h=>h.emit('blur'),h=>h.key('Escape'),h=>h.node('#settingsBtn').click(),
    h=>{h.document.hidden=true;h.emit('document:visibilitychange');},h=>h.node('[data-mode="classic"]').click()];
  for(const interrupt of interruptions){
    const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);
    h.holdKey('KeyG');h.advance(320);interrupt(h);h.advance(900);h.releaseKey('KeyG');h.tick();
    assert.equal(autoplayState(h).active,false);
    assert.equal(autoplayState(h).pressing,false);
    assert.equal(h.api.settings.coach,false,'a cancelled hold must not become a short press on release');
    assert.equal(h.controllers.flatMap(controller=>controller.requests).length,0);
  }
});

test('autoplay follows real hold, rotation and movement operations, then searches and places the next piece',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);
  h.api.game.state.active={type:'O',x:3,y:3,rotation:0};h.api.game.state.holdType='I';
  h.api.game.state.queue=['O','L','T','S','J','Z'];
  const calls=[];
  for(const name of ['move','rotate','hold','hardDrop']){
    const original=h.api.game[name];h.api.game[name]=function(...args){calls.push([name,...args]);return original.apply(this,args);};
  }
  longCoachPress(h);const controller=h.controllers.at(-1),first=coachRequest(h);
  const result=explicitRecommendation(first,{type:'I',x:7,y:20,rotation:1},['hold','cw','right','right','right','right','hard'],true);
  const expected=C.applyPath(first.view,result.move),target=copy(result.move.cells);
  controller.reply(result,first.key);
  advanceUntil(h,()=>calls.some(([name])=>name==='hold'));
  assert.deepEqual(fixedTarget(h).cells,target,'the recommended held piece keeps the same placement after the exchange');
  assert.equal(controller.requests.length,1,'the expected hold does not ask for a different target');
  advanceUntil(h,()=>h.api.game.state.pieces===1);
  assert.deepEqual(copy(h.api.game.state.board),expected.board);
  assert.equal(calls.filter(([name])=>name==='hold').length,1);
  assert.ok(calls.some(([name])=>name==='rotate'));
  assert.ok(calls.filter(([name])=>name==='move').length>=4);
  assert.equal(calls.filter(([name])=>name==='hardDrop').length,1);
  advanceUntil(h,()=>controller.requests.length>=2);
  const second=coachRequest(h);assert.notEqual(second.key,first.key);
  const next=recommendation(second),expectedNext=C.applyPath(second.view,next.move);
  controller.reply(next,second.key);advanceUntil(h,()=>h.api.game.state.pieces===2);
  assert.deepEqual(copy(h.api.game.state.board),expectedNext.board);
  assert.equal(calls.filter(([name])=>name==='hardDrop').length,2);
  assert.equal(autoplayState(h).active,true);
  assert.ok(h.effectCalls.some(call=>call.method==='consume'&&call.events.some(event=>event.type==='harddrop')),
    'automatic drops use the same real effects event path without delaying the next turn');
});

test('natural gravity while a worker is pending re-routes to the same target before autoplay locks it',()=>{
  const h=appHarness();start(h);h.api.game.state.active={type:'T',x:3,y:3,rotation:0};h.api.game.state.canHold=false;
  longCoachPress(h);const request=coachRequest(h),controller=h.controllers.at(-1);
  const result=explicitRecommendation(request,{type:'T',x:7,y:21,rotation:1},[...Array(18).fill('soft'),'cw','right','right','right','right','hard']);
  const expected=C.applyPath(request.view,result.move),initialY=h.api.game.state.active.y;
  h.advance(1200);
  assert.ok(h.api.game.state.active.y>initialY,'gravity has advanced the piece before the response');
  assert.equal(C.applyPath(h.api.game.state,result.move).valid,false,'the old counted soft drops can no longer execute as originally planned');
  controller.reply(result,request.key);advanceUntil(h,()=>h.api.game.state.pieces===1);
  assert.deepEqual(copy(h.api.game.state.board),expected.board);
  assert.equal(autoplayState(h).active,true);
});

test('autoplay recognizes a zero-distance hard drop as a successful full T-Spin lock',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);
  const g=h.api.game;g.state.active={type:'T',x:3,y:21,rotation:1};g.state.canHold=false;
  g.state.board[21][3]='J';
  for(let x=0;x<E.COLS;x++){
    if(x<3||x>5)g.state.board[22][x]='J';
    if(x!==4)g.state.board[23][x]='J';
  }
  const drops=[],original=g.hardDrop;g.hardDrop=function(){const result=original.call(this);drops.push(result);return result;};
  longCoachPress(h);const request=coachRequest(h),controller=h.controllers.at(-1);
  const result=explicitRecommendation(request,{type:'T',x:3,y:21,rotation:2},['cw','hard']);
  assert.equal(result.metrics.spin,'full');controller.reply(result,request.key);
  advanceUntil(h,()=>h.api.game.state.pieces===1);
  assert.deepEqual(drops,[0]);
  assert.equal(g.state.lastClear.spin,'full');assert.equal(g.state.lastClear.lines,2);
  assert.equal(g.state.lastClear.points,1200);assert.equal(g.state.tspins,1);
  assert.equal(autoplayState(h).active,true);
  advanceUntil(h,()=>controller.requests.length>=2);
  assert.equal(controller.requests.length,2,'the zero return value does not trigger a retry search');
});

test('manual control, pause, dialogs, mode changes, undo and restart stop autoplay before any late response can act',()=>{
  const interruptions=[h=>h.key('ArrowLeft'),h=>h.key('ArrowUp'),h=>h.key('Space'),h=>h.key('KeyC'),h=>h.key('Escape'),
    h=>h.node('#settingsBtn').click(),h=>h.node('[data-mode="classic"]').click(),h=>h.key('KeyU'),h=>h.key('KeyR'),
    h=>h.emit('blur'),h=>h.emit('storage',{key:STORAGE_KEY,newValue:'external-update'})];
  for(const interrupt of interruptions){
    const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);h.key('Space');h.tick();
    longCoachPress(h);const request=coachRequest(h),controller=h.controllers.at(-1),result=recommendation(request);
    assert.equal(autoplayState(h).active,true,'the interruption must stop an actually running auto session');
    interrupt(h);h.tick();assert.equal(autoplayState(h).active,false);
    const pieces=h.api.game.state.pieces,board=copy(h.api.game.state.board),session=h.api.session.id;
    controller.reply(result,request.key);h.advance(1200);
    assert.equal(autoplayState(h).active,false);
    assert.equal(h.api.session.id,session,'a stopped auto session never restarts itself');
    assert.equal(h.api.game.state.pieces,pieces,'late computation cannot place another piece');
    assert.deepEqual(copy(h.api.game.state.board),board);
  }
});

test('a long press stops autoplay while waiting and its late answer cannot resume play',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));longCoachPress(h);
  const request=coachRequest(h),controller=h.controllers.at(-1),result=recommendation(request);
  longCoachPress(h);assert.equal(autoplayState(h).active,false);
  const before=copy(h.api.game.state);
  controller.reply(result,request.key);h.advance(2000);
  assert.equal(autoplayState(h).active,false);
  assert.equal(h.api.game.state.pieces,before.pieces);assert.deepEqual(copy(h.api.game.state.board),before.board);
  assert.equal(h.api.settings.coach,false);
});

test('autoplay automatically starts another session after a terminal game and marks both sessions as practice',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);
  const g=h.api.game;g.state.active={type:'O',x:3,y:1,rotation:0};g.state.canHold=false;
  g.state.board[3][4]='J';g.state.board[3][5]='J';
  longCoachPress(h);const oldSession=h.api.session.id,request=coachRequest(h),controller=h.controllers.at(-1);
  controller.reply(recommendation(request),request.key);advanceUntil(h,()=>h.api.game.state.status==='over');
  assert.equal(autoplayState(h).active,true);
  assert.equal(h.api.session.id,oldSession);
  advanceUntil(h,()=>h.api.session.id!==oldSession,2000);
  assert.equal(h.api.game.state.status,'running');assert.equal(h.api.game.state.pieces,0);
  assert.equal(autoplayState(h).active,true);assert.equal(h.api.session.autoplayed,true);
  const previous=h.stored().records.find(record=>record.id===oldSession);
  assert.equal(previous.autoplayed,true);assert.equal(previous.assisted,true);
});

test('autoplay assistance persists in saves and records but reopening and importing never resume automation',async()=>{
  const ordinary={id:'ordinary',mode:'marathon',outcome:'over',score:10,lines:0,elapsedMs:1000,pieces:1,tetrises:0,tspins:0,endedAt:Date.now()};
  const highAuto={...ordinary,id:'previous-auto',score:900,autoplayed:true};
  const h=appHarness(stored(oldSettings(),[ordinary,highAuto]));
  assert.equal(h.node('#personalBest').textContent,'10','the explicit autoplay flag excludes older auto records even without other flags');
  longCoachPress(h);h.api.persist();
  assert.equal(h.api.session.autoplayed,true);assert.equal(h.stored().saves.marathon.autoplayed,true);
  const restored=appHarness(h.stored());
  assert.equal(autoplayState(restored).active,false);assert.equal(restored.api.game.state.status,'paused');
  assert.equal(restored.api.session.autoplayed,true);
  restored.node('#exportBtn').click();const backup=JSON.parse(await restored.downloads.at(-1).text());
  const imported=appHarness(stored(oldSettings({lastMode:'zen'})));longCoachPress(imported);
  const oldRequest=coachRequest(imported),controller=imported.controllers.at(-1),result=recommendation(oldRequest);
  await importBackup(imported,backup);
  assert.equal(autoplayState(imported).active,false);assert.equal(imported.api.session.autoplayed,true);
  assert.equal(imported.api.game.state.mode,'marathon');assert.equal(imported.api.game.state.status,'paused');
  controller.reply(result,oldRequest.key);imported.advance(1200);
  assert.equal(autoplayState(imported).active,false);assert.equal(imported.api.game.state.pieces,0);
  longCoachPress(h);assert.equal(autoplayState(h).active,false);
  h.api.game.state.score=1000;h.api.game.state.pieces=1;h.api.record('over');
  const record=h.stored().records.find(item=>item.id===h.api.session.id);
  assert.equal(record.autoplayed,true);assert.equal(record.assisted,true);
  assert.equal(h.node('#personalBest').textContent,'10');
  const legacy=appHarness(stored(oldSettings(),[ordinary]));start(legacy);
  assert.equal(autoplayState(legacy).active,false);assert.equal(!!legacy.api.session.autoplayed,false);
});

function prepareSingleClear(harness) {
  const s=harness.api.game.state;
  s.active={type:'I',x:3,y:3,rotation:0};s.canHold=false;
  s.board=Array.from({length:E.ROWS},()=>Array(E.COLS).fill(null));
  for(let x=0;x<E.COLS;x++)if(x<3||x>6)s.board[E.ROWS-1][x]='J';
  s.board[E.ROWS-3][0]='J'; // Keep this a single rather than an all-clear.
}

test('hard-drop and clear feedback starts after audio and cannot postpone or alter the real lock',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen',sound:true})));start(h);prepareSingleClear(h);
  const expected=E.Game.restore(h.api.game.serialize());expected.hardDrop();
  h.eventOrder.length=0;h.effectCalls.length=0;h.soundCalls.length=0;
  h.key('Space');
  assert.deepEqual(h.api.game.serialize(),expected.serialize(),'visual feedback never postpones lock, scoring, queue or undo state');
  assert.equal(h.api.game.state.lines,1);assert.equal(h.api.game.state.pieces,1);
  assert.deepEqual(h.soundCalls,['harddrop','clear']);
  const consumeIndex=h.eventOrder.findIndex(event=>event.type==='effects');
  assert.ok(consumeIndex>0);
  assert.ok(h.eventOrder.slice(0,consumeIndex).every(event=>event.type==='sound'));
  assert.ok(h.eventOrder.every((event,index)=>event.type!=='sound'||index<consumeIndex),'all sounds dispatch before any effects work');
  const batch=h.eventOrder[consumeIndex].events;
  assert.ok(batch.some(event=>event.type==='harddrop'&&event.distance>0));
  assert.ok(batch.some(event=>event.type==='lock'&&event.cells.length===4));
  assert.ok(batch.some(event=>event.type==='clear'&&event.lines===1));
  assert.equal(h.effectInstances.length,1);assert.equal(h.effectInstances[0].stats().active,true);
  h.tick();
  assert.ok(h.effectCalls.some(call=>call.method==='draw'&&call.active),'the normal board render draws the actual animation');
});

test('drop and clear effects animate and expire during idle zen frames with no gameplay changes',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);prepareSingleClear(h);
  h.key('Space');h.tick();
  const fx=h.effectInstances[0],before=copy(h.api.game.state);
  assert.equal(fx.stats().active,true);
  h.effectCalls.length=0;h.advance(1600);
  const frames=h.effectCalls.filter(call=>call.method==='draw');
  assert.ok(frames.some(call=>call.active),'a later RAF continues the animation without a new key');
  assert.ok(frames.some(call=>!call.active),'a later RAF also draws the final clean board');
  assert.equal(fx.stats().active,false);assert.equal(fx.stats().particles,0);assert.equal(fx.stats().effects,0);
  assert.equal(h.api.effectsAnimating,false);
  assert.equal(h.api.game.state.score,before.score);assert.equal(h.api.game.state.lines,before.lines);
  assert.equal(h.api.game.state.pieces,before.pieces);assert.deepEqual(copy(h.api.game.state.board),before.board);
  assert.deepEqual(copy(h.api.game.state.active),before.active);
});

test('pause, mode switch, undo and restart clear in-flight effects before showing another board',()=>{
  const interruptions=[['pause',h=>h.key('Escape')],['mode',h=>h.key('Digit5')],
    ['undo',h=>h.key('KeyU')],['restart',h=>{h.key('KeyR');h.key('Enter');}]];
  for(const [name,interrupt] of interruptions){
    const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);h.key('Space');h.tick();
    const fx=h.effectInstances[0];assert.equal(fx.stats().active,true,name+' interrupts a live effect');
    interrupt(h);h.tick();
    assert.equal(fx.stats().active,false,name+' clears the effect');assert.equal(h.api.effectsAnimating,false);
    assert.equal(fx.stats().particles,0);assert.equal(fx.stats().effects,0);
    h.advance(1000);assert.equal(fx.stats().active,false,name+' cannot resurrect a previous board effect');
  }
});

test('system reduced motion disables board displacement while keeping immediate lock and clear feedback',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})),{reducedMotion:true});start(h);prepareSingleClear(h);
  const expected=E.Game.restore(h.api.game.serialize());expected.hardDrop();h.key('Space');
  assert.deepEqual(h.api.game.serialize(),expected.serialize());
  const fx=h.effectInstances[0];assert.equal(fx.stats().reducedMotion,true);
  assert.deepEqual(copy(fx.offset(h.now)),{x:0,y:0});
  h.tick();assert.ok(h.effectCalls.some(call=>call.method==='draw'&&call.active),'reduced motion retains brief clear feedback');
  h.advance(1600);assert.equal(fx.stats().active,false);assert.equal(h.api.effectsAnimating,false);
});

test('a stationary running board stays unpainted while its clock keeps accurate time',()=>{
  for(const mode of ['zen','marathon']) {
    const h=appHarness(stored(oldSettings({lastMode:mode})));start(h);
    const before=h.api.game.state.elapsedMs,active=copy(h.api.game.state.active);
    h.canvasEvents.length=0;h.domWrites.length=0;h.effectCalls.length=0;
    const duration=mode==='zen'?1100:750;
    h.advance(duration);
    assert.equal(h.api.game.state.elapsedMs,before+duration,mode+' keeps the real elapsed clock');
    assert.deepEqual(copy(h.api.game.state.active),active,mode+' has not moved yet');
    assert.deepEqual(h.canvasEvents,[],mode+' draws no unchanged board or previews');
    assert.equal(h.effectCalls.filter(call=>call.method==='consume').length,0,'empty event batches do not enter effects');
    assert.ok(h.domWrites.filter(write=>write.selector==='#time').length<=2,'whole-second clock text does not update every frame');
    if(mode==='zen')assert.equal(h.node('#time').textContent,'00:01');
  }
});

test('moving a live piece repaints the board without rebuilding unchanged hold and next previews',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);
  h.canvasEvents.length=0;h.key('ArrowLeft');h.tick();
  assert.ok(h.canvasEvents.some(call=>call.selector==='#board'),'movement appears on the next paint');
  assert.equal(h.canvasEvents.filter(call=>call.selector==='#hold'||call.selector==='#next').length,0);
  h.canvasEvents.length=0;h.key('ArrowUp');h.tick();
  assert.ok(h.canvasEvents.some(call=>call.selector==='#board'));
  assert.equal(h.canvasEvents.filter(call=>call.selector==='#hold'||call.selector==='#next').length,0);
  h.canvasEvents.length=0;h.key('KeyC');h.tick();
  assert.ok(h.canvasEvents.some(call=>call.selector==='#hold'),'a changed hold is repainted');
  assert.ok(h.canvasEvents.some(call=>call.selector==='#next'),'empty hold consumes and repaints the preview queue');
});

test('ready and paused games stop requesting frames and keyboard input wakes them exactly once',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));
  h.tick();assert.equal(h.pendingFrames,0,'ready screen has no perpetual RAF');
  h.canvasEvents.length=0;h.advance(2000);
  assert.equal(h.pendingFrames,0);assert.deepEqual(h.canvasEvents,[]);
  h.holdKey('KeyG');
  assert.equal(h.pendingFrames,1,'a long-press can start on the sleeping ready screen');
  h.advance(650);h.releaseKey('KeyG');h.tick();
  assert.equal(autoplayState(h).active,true);assert.equal(h.api.game.state.status,'running');
  h.key('Escape');h.tick();
  assert.equal(autoplayState(h).active,false);assert.equal(h.pendingFrames,0);
  const elapsed=h.api.game.state.elapsedMs;
  h.advance(5000);assert.equal(h.api.game.state.elapsedMs,elapsed,'paused wall time never becomes play time');
  h.key('Enter');h.tick();
  assert.equal(h.api.game.state.status,'running');assert.equal(h.api.game.state.elapsedMs,elapsed+16);
  assert.equal(h.pendingFrames,1,'resuming has a single live RAF chain');
});

test('a late worker answer wakes a sleeping paused screen and resumes with its fixed target',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);enable(h);
  const request=coachRequest(h),result=recommendation(request);
  h.key('Escape');h.tick();assert.equal(h.pendingFrames,0);
  h.controllers.at(-1).reply(result,request.key);
  assert.equal(h.pendingFrames,1,'asynchronous result schedules a paint without an existing animation loop');
  h.tick();assert.equal(h.pendingFrames,0);assert.equal(!!h.api.session.coached,false);
  h.key('Enter');h.tick();
  assert.deepEqual(fixedTarget(h),copy({piece:result.move.piece,cells:result.move.cells}));
  assert.equal(h.controllers.at(-1).requests.length,1);assert.equal(h.api.session.coached,true);
});

test('a live reduced-motion preference change wakes idle UI and lets current effects finish cleanly',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));h.tick();
  assert.equal(h.pendingFrames,0);
  h.setReducedMotion(true);assert.equal(h.pendingFrames,1);h.tick();
  assert.equal(h.effectInstances[0].stats().reducedMotion,true);assert.equal(h.pendingFrames,0);
  h.setReducedMotion(false);h.tick();start(h);prepareSingleClear(h);h.key('Space');h.tick();
  const fx=h.effectInstances[0];assert.ok(fx.stats().particles>0);
  h.setReducedMotion(true);h.tick();
  assert.equal(fx.stats().reducedMotion,true);assert.equal(fx.stats().particles,0);
  assert.deepEqual(copy(fx.offset(h.now)),{x:0,y:0});
  h.advance(200);assert.equal(fx.stats().active,false);assert.equal(h.api.effectsAnimating,false);
  h.canvasEvents.length=0;h.advance(400);assert.deepEqual(h.canvasEvents,[],'no animation tail remains after its final clean paint');
});

test('frame scheduling preserves natural gravity and lock timing at slow and fast levels',()=>{
  const normalized=value=>JSON.parse(JSON.stringify(value,(key,item)=>['elapsedMs','fallMs','lockMs'].includes(key)?Math.round(item*1e6)/1e6:item));
  for(const [mode,startLevel]of [['marathon',1],['marathon',20],['classic',20],['ultra',1],['zen',1]]) {
    const h=appHarness(stored(oldSettings({lastMode:mode,startLevel})));start(h);
    const expected=E.Game.restore(h.api.game.serialize());
    h.advance(1300);expected.tick(1300);
    // Different time-step groupings can differ below a microsecond at 20 G.
    assert.deepEqual(normalized(h.api.game.serialize()),normalized(expected.serialize()),mode+' level '+startLevel+' matches the engine independent of paint cadence');
  }
  const h=appHarness(stored(oldSettings()));start(h);
  h.api.game.state.active.y=E.ghostY(h.api.game.state);h.api.game.state.fallMs=0;h.api.game.state.lockMs=0;
  h.advance(499,1);assert.equal(h.api.game.state.pieces,0,'contact waits the entire lock delay');
  h.advance(1);assert.equal(h.api.game.state.pieces,1,'lock still occurs exactly at its configured deadline');
});

test('held horizontal input preserves DAS, ARR and instant wall movement when most frames do not paint',()=>{
  for(const arr of [35,0]) {
    const h=appHarness(stored(oldSettings({lastMode:'zen',das:150,arr})));start(h);
    h.api.game.state.active={type:'O',x:3,y:3,rotation:0};
    h.holdKey('ArrowLeft');assert.equal(h.api.game.state.active.x,2);
    h.advance(149,1);assert.equal(h.api.game.state.active.x,2,'no horizontal repeat before DAS');
    h.advance(1);
    if(arr===0)assert.equal(Math.min(...E.getCells(h.api.game.state.active).map(cell=>cell.x)),0,'ARR 0 reaches the wall at DAS');
    else {
      assert.equal(h.api.game.state.active.x,1);
      h.advance(34,1);assert.equal(h.api.game.state.active.x,1);
      h.advance(1);assert.equal(h.api.game.state.active.x,0,'the next move occurs at ARR');
    }
    h.releaseKey('ArrowLeft');const active=copy(h.api.game.state.active);h.advance(300);
    assert.deepEqual(copy(h.api.game.state.active),active,'keyup prevents deferred repeats');
  }
});

test('held soft drop retains its configured repeat interval without continuous redraw',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen',softInterval:35})));start(h);
  h.api.game.state.active={type:'O',x:3,y:3,rotation:0};
  h.holdKey('ArrowDown');assert.equal(h.api.game.state.active.y,4);
  h.advance(34,1);assert.equal(h.api.game.state.active.y,4);
  h.advance(1);assert.equal(h.api.game.state.active.y,5);
  h.advance(70,1);assert.equal(h.api.game.state.active.y,7);
  h.releaseKey('ArrowDown');h.tick();h.canvasEvents.length=0;h.advance(400);
  assert.equal(h.api.game.state.active.y,7);assert.deepEqual(h.canvasEvents,[],'released soft drop leaves a static board');
});

test('continuous input coalesces storage work and checkpoints the latest position within one second',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);
  h.storageWrites.length=0;h.advance(200);
  for(const key of ['ArrowLeft','ArrowRight','ArrowLeft','ArrowLeft']){h.key(key);h.advance(100);}
  const active=copy(h.api.game.state.active);
  h.advance(300);assert.equal(h.storageWrites.length,0,'input bursts do not serialize the whole save every 100 ms');
  h.advance(150);
  assert.equal(h.storageWrites.length,1,'timer and running checkpoint share one save deadline');
  const saved=h.stored().saves.zen.snapshot;
  assert.deepEqual(saved.active,active);assert.deepEqual(saved.board,copy(h.api.game.state.board));
  assert.deepEqual(saved.queue,copy(h.api.game.state.queue));
  assert.ok(h.api.game.state.elapsedMs-saved.elapsedMs<100,'the checkpoint includes recent play time');
});

test('pausing, hiding, blurring and switching mode flush pending input before returning',()=>{
  const interruptions=[['pause',h=>h.key('Escape')],['hidden',h=>{h.document.hidden=true;h.emit('document:visibilitychange');}],
    ['pagehide',h=>h.emit('pagehide')],['blur',h=>h.emit('blur')],['mode',h=>h.key('Digit1')]];
  for(const [name,interrupt]of interruptions) {
    const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);h.advance(200);h.key('ArrowLeft');
    const active=copy(h.api.game.state.active),elapsed=h.api.game.state.elapsedMs;
    h.storageWrites.length=0;interrupt(h);
    const saved=h.stored().saves.zen.snapshot;
    assert.deepEqual(saved.active,active,name+' saves the last movement synchronously');
    assert.equal(saved.elapsedMs,elapsed);assert.equal(saved.status,'paused');
    assert.ok(h.storageWrites.length>=1,name+' writes before its handler returns');
    h.advance(1200);
    assert.deepEqual(h.stored().saves.zen.snapshot,saved,name+' cancels any stale delayed overwrite');
  }
});

test('export flushes pending progress and undo checkpoints its restored board immediately',async()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);h.advance(200);h.key('Space');h.tick();
  h.key('ArrowLeft');h.node('#exportBtn').click();
  const exported=JSON.parse(await h.downloads.at(-1).text());
  assert.deepEqual(exported.saves.zen.snapshot,h.api.game.serialize(),'export contains the current state before its background checkpoint');
  h.key('KeyU');
  assert.equal(h.api.game.state.pieces,0);
  assert.deepEqual(h.stored().saves.zen.snapshot,h.api.game.serialize(),'undo stores the restored turn rather than an earlier pending move');
});

test('identical saves avoid duplicate writes, and a failed write is retried rather than treated as saved',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);
  h.api.persist();h.storageWrites.length=0;h.api.persist();
  assert.equal(h.storageWrites.length,0,'the same serialized state has no redundant setItem');
  h.advance(100);h.key('ArrowLeft');h.failStorageWrites();
  const before=h.storageAttempts.length;
  assert.equal(h.api.persist(),false);assert.equal(h.storageAttempts.length,before+1);
  assert.equal(h.node('#saveStatus').textContent,'存档失败 · 请导出备份');
  assert.equal(h.api.persist(),true,'a transient storage failure does not poison duplicate detection');
  assert.equal(h.storageAttempts.length,before+2);
  assert.deepEqual(h.stored().saves.zen.snapshot,h.api.game.serialize());
});

test('an external-window update prevents pending checkpoints from overwriting the other game',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);h.advance(200);h.key('ArrowLeft');
  const savedBefore=h.storage.get(STORAGE_KEY);
  h.storageWrites.length=0;h.emit('storage',{key:STORAGE_KEY,newValue:'a newer save from another window'});
  assert.equal(h.api.game.state.status,'paused');h.advance(1600);
  assert.equal(h.storageWrites.length,0);assert.equal(h.storage.get(STORAGE_KEY),savedBefore);
  assert.equal(h.api.persist(),false,'forced saves also respect the external-update guard');
});

test('temporary storage failure retries at a checkpoint rate during continued input rather than every frame',()=>{
  const h=appHarness(stored(oldSettings({lastMode:'zen'})));start(h);
  h.failStorageWrites(1000);h.key('ArrowLeft');h.advance(1000);
  const attempts=h.storageAttempts.length;
  assert.ok(attempts>=1);
  for(let index=0;index<5;index++){h.key(index%2?'ArrowLeft':'ArrowRight');h.advance(100);}
  assert.equal(h.storageAttempts.length,attempts,'failed storage does not cause repeated frame or key-event writes');
  h.advance(500);
  assert.equal(h.storageAttempts.length,attempts+1,'the next one-second checkpoint retries automatically');
  h.failStorageWrites(0);h.key('Escape');
  assert.equal(h.stored().saves.zen.snapshot.status,'paused','pause flushes immediately even after a recent failure');
});

test('audio work follows saved sound preference and window activity without disabling normal pause sounds',()=>{
  const muted=appHarness();
  assert.equal(muted.audioLifecycle.find(call=>call.method==='constructor').config.enabled,false,'audio starts dormant before saved preferences are loaded');
  assert.equal(muted.audioLifecycle.filter(call=>call.method==='enabled').at(-1).value,false);
  const h=appHarness(stored(oldSettings({lastMode:'zen',sound:true})));start(h);
  assert.equal(h.audioLifecycle.filter(call=>call.method==='enabled').at(-1).value,true);
  h.audioLifecycle.length=0;h.key('Escape');h.tick();
  assert.equal(h.audioLifecycle.some(call=>call.method==='active'&&call.value===false),false,'manual pause preserves settings preview audio readiness');
  h.emit('blur');assert.equal(h.audioLifecycle.at(-1).method,'active');assert.equal(h.audioLifecycle.at(-1).value,false);
  h.emit('focus');assert.equal(h.audioLifecycle.at(-1).value,true);
  h.document.hidden=true;h.emit('document:visibilitychange');assert.equal(h.audioLifecycle.at(-1).value,false);
  h.document.hidden=false;h.emit('document:visibilitychange');assert.equal(h.audioLifecycle.at(-1).value,true);
  assert.equal(h.api.game.state.status,'paused','returning focus never resumes gameplay implicitly');
});

test('trying a sound while muted is temporary and closing settings restores the mute preference',()=>{
  const h=appHarness();h.node('#settingsBtn').click();
  const preview=h.node('#soundLibrary').children[0].children[2];
  h.audioLifecycle.length=0;preview.click();
  assert.ok(h.audioLifecycle.some(call=>call.method==='enabled'&&call.value===true));
  assert.equal(h.audioLifecycle.at(-1).method,'preview');
  h.node('#settingsDialog').close();
  assert.equal(h.audioLifecycle.filter(call=>call.method==='enabled').at(-1).value,false);
  assert.equal(h.api.settings.sound,false,'preview does not change the persisted sound switch');
});

