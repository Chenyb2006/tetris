'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const A = require('../audio.js');
const E = require('../engine.js');

class FakeParam {
  constructor(value = 1) {this.value = value; this.calls = [];}
  setValueAtTime(value, time) {this.value = value; this.calls.push(['set',value,time]);}
  cancelScheduledValues(time) {this.calls.push(['cancel',time]);}
  setTargetAtTime(value, time, constant) {this.value = value; this.calls.push(['target',value,time,constant]);}
  linearRampToValueAtTime(value, time) {this.value = value; this.calls.push(['ramp',value,time]);}
}
class FakeNode {
  constructor() {this.gain = new FakeParam(); this.connected = [];}
  connect(node) {this.connected.push(node); return node;}
  disconnect() {this.disconnected = true;}
}
class FakeAudioContext {
  static instances = [];
  constructor(options) {
    this.options = options; this.sampleRate = 16000; this.currentTime = 12.25;
    this.state = 'suspended'; this.destination = {}; this.sources = []; this.buffers = [];
    this.resumeCount = 0; this.baseLatency = .005; this.outputLatency = .01;
    FakeAudioContext.instances.push(this);
  }
  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length), buffer = {channels, length, sampleRate, getChannelData: () => data};
    this.buffers.push(buffer); return buffer;
  }
  createGain() {return new FakeNode();}
  createBufferSource() {
    const node = new FakeNode(); node.starts = []; node.stops = [];
    node.start = time => node.starts.push(time); node.stop = time => node.stops.push(time);
    this.sources.push(node); return node;
  }
  resume() {this.resumeCount++; this.state = 'running'; return Promise.resolve();}
  suspend() {this.suspendCount=(this.suspendCount||0)+1; this.state='suspended'; return Promise.resolve();}
}

test('all events have valid defaults; independent config normalizes volume and unknown sounds', () => {
  assert.ok(A.PRESETS.length >= 13);
  assert.equal(new Set(A.PRESETS.map(p => p.id)).size, A.PRESETS.length);
  const config = A.normalizeConfig({volume:150, map:{move:'silence', rotate:'missing', lock:'bell'}});
  assert.equal(config.volume,100); assert.equal(config.map.move,'silence');
  assert.equal(config.map.rotate,A.DEFAULT_MAP.rotate); assert.equal(config.map.lock,'bell');
  assert.equal(A.normalizeConfig({volume:-1}).volume,0);
  assert.equal(A.normalizeConfig({volume:NaN}).volume,60);
  assert.equal(A.normalizeConfig({volume:'loud'}).volume,60);
  assert.equal(A.normalizeConfig(null).volume,60);
  assert.deepEqual(A.normalizeConfig({map:{move:'__proto__'}}).map,A.DEFAULT_MAP);
  for (const {id} of A.EVENTS) assert.ok(A.PRESETS.some(p => p.id === config.map[id]));
  config.map.start = 'silence';
  assert.equal(A.normalizeConfig().map.start,A.DEFAULT_MAP.start);
});

test('unlock requests interactive audio once and prepares all buffers before playback', () => {
  const engine = new A.SoundEngine({AudioContext:FakeAudioContext});
  assert.equal(engine.play('rotate'),false);
  assert.equal(engine.unlock(),true);
  const context = engine.context;
  assert.deepEqual(context.options,{latencyHint:'interactive'});
  assert.equal(context.resumeCount,1);
  assert.equal(context.buffers.length,A.PRESETS.length-1);
  assert.equal(engine.unlock(),true); assert.equal(engine.context,context);
  assert.equal(context.buffers.length,A.PRESETS.length-1);
  assert.equal(engine.play('rotate'),true);
  const first = context.sources[0];
  assert.deepEqual(first.starts,[context.currentTime]);
  assert.equal(engine.play('rotate'),true);
  assert.equal(context.sources[1].buffer,first.buffer);
  assert.equal(context.buffers.length,A.PRESETS.length-1);
  assert.equal(engine.stats().played,2);
});

test('a pending browser resume never delays scheduling in the input callback', () => {
  class PendingContext extends FakeAudioContext {
    resume() {this.resumeCount++; return new Promise(resolve => {this.resolveResume=resolve;});}
  }
  const engine = new A.SoundEngine({AudioContext:PendingContext});
  engine.unlock();
  assert.equal(engine.context.state,'suspended');
  assert.equal(engine.play('harddrop'),true);
  assert.deepEqual(engine.context.sources[0].starts,[12.25]);
  engine.unlock(false);
  assert.equal(engine.context.resumeCount,1);
  engine.unlock();
  assert.equal(engine.context.resumeCount,2,'a new input retries resume inside its gesture');
  engine.context.resolveResume();
});

test('autoplay-blocked startup resume cannot suppress the first real input unlock or replay a cue', async () => {
  let inUserGesture=false;
  class AutoplayBlockedContext extends FakeAudioContext {
    resume() {
      this.resumeCount++;
      if (!inUserGesture) return new Promise(resolve=>{this.resolveBlockedResume=resolve;});
      this.state='running';return Promise.resolve();
    }
  }
  const audio=new A.SoundEngine({AudioContext:AutoplayBlockedContext,enabled:false});
  audio.configure({volume:60});audio.setEnabled(true);
  const context=audio.context,buffer=audio.buffers.get('drop');
  assert.equal(context.state,'suspended');assert.equal(context.resumeCount,1);
  audio.configure({volume:55});audio.setActive(true);audio.setEnabled(true);
  assert.equal(context.resumeCount,1,'non-input prewarming merges pending requests');
  assert.equal(context.sources.length,0);
  inUserGesture=true;
  assert.equal(audio.unlock(),true);
  assert.equal(context.resumeCount,2);assert.equal(context.state,'running');
  assert.equal(audio.play('harddrop'),true);
  assert.equal(audio.context,context);assert.equal(context.buffers.length,21);
  assert.equal(context.sources[0].buffer,buffer);assert.deepEqual(context.sources[0].starts,[context.currentTime]);
  context.resolveBlockedResume();
  await Promise.resolve();await Promise.resolve();
  assert.equal(context.sources.length,1,'settling the blocked startup promise never replays the input');
  audio.unlock();assert.equal(context.resumeCount,2,'an already running graph needs no further resume');
});

test('cached original sounds start in under 1 ms, end at zero, and stay within headroom', () => {
  const engine = new A.SoundEngine({AudioContext:FakeAudioContext}); engine.unlock();
  const distinct = new Set();
  for (const [id,buffer] of engine.buffers) {
    const samples = buffer.getChannelData(0);
    assert.equal(samples[0],0,id); assert.ok(Math.abs(samples[samples.length-1]) < .000001,id);
    const first = samples.findIndex(value => Math.abs(value) > .00001);
    assert.ok(first > 0 && first / buffer.sampleRate < .001,id);
    let peak=0;
    for(const sample of samples) {assert.ok(Number.isFinite(sample),id); peak=Math.max(peak,Math.abs(sample));}
    assert.ok(peak <= .440001 && peak > .439,id);
    distinct.add(Array.from(samples.slice(0,200)).map(value=>value.toFixed(4)).join(','));
  }
  // Presets that share the same opening note diverge later; most differ immediately.
  assert.ok(distinct.size >= 15);
});

test('silence and zero volume avoid creating a source; reconfiguration is immediate', () => {
  const engine = new A.SoundEngine({AudioContext:FakeAudioContext}); engine.unlock();
  assert.equal(engine.preview('silence'),false);
  assert.equal(engine.preview('unknown'),false);
  assert.equal(engine.play('not-an-event'),false);
  engine.configure({volume:0});
  assert.equal(engine.play('lock'),false); assert.equal(engine.context.sources.length,0);
  engine.configure({volume:50,map:{lock:'bell'}});
  assert.equal(engine.master.gain.value,.115);
  assert.equal(engine.play('lock'),true);
  assert.equal(engine.context.sources[0].buffer,engine.buffers.get('bell'));
});

test('fast repeats drop excess cues without delayed playback or affecting other actions', () => {
  let time = 100;
  const engine = new A.SoundEngine({AudioContext:FakeAudioContext,now:()=>time}); engine.unlock();
  assert.equal(engine.play('move'),true); time+=19;
  assert.equal(engine.play('move'),false); assert.equal(engine.play('rotate'),true); time++;
  assert.equal(engine.play('move'),true);
  assert.equal(engine.play('softdrop'),true);
  assert.equal(engine.context.sources.length,4);
  for(const source of engine.context.sources) assert.deepEqual(source.starts,[12.25]);
});

test('busy sequences cap active voices and fade old voices rather than clipping abruptly', () => {
  const engine = new A.SoundEngine({AudioContext:FakeAudioContext}); engine.unlock();
  for(let i=0;i<12;i++) assert.equal(engine.play('rotate'),true);
  assert.equal(engine.stats().activeVoices,8);
  const oldest = engine.context.sources[0], voiceGain = oldest.connected[0];
  assert.deepEqual(voiceGain.gain.calls.at(-1),['ramp',0,12.253]);
  assert.deepEqual(oldest.stops,[12.254]);
  const newest = engine.context.sources.at(-1); newest.onended();
  assert.equal(engine.stats().activeVoices,7); assert.equal(newest.disconnected,true);
});

test('contact cancels every long soft-drop tail without stopping other actions or delaying the next cue', () => {
  let time=100;
  const engine=new A.SoundEngine({AudioContext:FakeAudioContext,now:()=>time});engine.unlock();
  engine.configure({map:{softdrop:'victory',rotate:'bell'}});
  assert.equal(engine.play('softdrop'),true);time+=35;
  assert.equal(engine.play('rotate'),true);
  assert.equal(engine.play('softdrop'),true);time+=35;
  assert.equal(engine.play('softdrop'),true);
  const [first,other,second,third]=engine.context.sources;
  assert.equal(engine.stats().activeVoices,4);
  assert.equal(engine.stop('softdrop'),3);
  assert.equal(engine.stats().activeVoices,1);
  for(const source of [first,second,third]) {
    assert.deepEqual(source.connected[0].gain.calls.at(-1),['ramp',0,12.253]);
    assert.deepEqual(source.stops,[12.254]);
  }
  assert.deepEqual(other.stops,[]);
  assert.equal(engine.stop('softdrop'),0);
  assert.equal(engine.stop('missing'),0);
  for(const source of [first,second,third])assert.equal(source.stops.length,1);
  // No clock advance: a genuine descent after contact can sound immediately.
  assert.equal(engine.play('softdrop'),true);
  const resumed=engine.context.sources.at(-1);
  assert.deepEqual(resumed.starts,[engine.context.currentTime]);
  assert.deepEqual(resumed.stops,[]);
  assert.equal(engine.stats().activeVoices,2);
  // End callbacks for cancelled tails must leave the other two voices intact.
  first.onended();second.onended();third.onended();
  assert.equal(engine.stats().activeVoices,2);
  assert.deepEqual(other.stops,[]);
});

test('unavailable audio is a safe no-op and closed contexts can unlock again', () => {
  const unavailable = new A.SoundEngine({AudioContext:undefined});
  assert.equal(unavailable.unlock(),false); assert.equal(unavailable.play('win'),false);
  const engine = new A.SoundEngine({AudioContext:FakeAudioContext}); engine.unlock();
  const context = engine.context; context.state='closed';
  assert.equal(engine.play('win'),false);
  assert.equal(engine.unlock(),true); assert.notEqual(engine.context,context);
  assert.equal(engine.context.state,'running');
  assert.equal(engine.context.resumeCount,1);
  assert.equal(engine.play('win'),true);
});

test('zen soft drop plays only for real descent, stays silent on contact, and resumes off a ledge', () => {
  let time=100;
  const audio=new A.SoundEngine({AudioContext:FakeAudioContext,now:()=>time});audio.unlock();
  const game=new E.Game({mode:'zen',seed:123456});game.start();game.drainEvents();
  game.state.active={type:'O',x:3,y:3,rotation:0};
  game.state.board[20][4]='J';game.state.board[20][5]='J';
  const played=[];
  const drain=()=>{for(const event of game.drainEvents())if(audio.play(event.type))played.push(event.type);};
  while(game.softDrop()){time+=35;drain();}
  assert.equal(played.length,15);
  assert.ok(played.every(event=>event==='softdrop'));
  const sourceCount=audio.context.sources.length;
  for(let i=0;i<9000;i++) {
    time+=35;if(!game.softDrop())audio.stop('softdrop');game.tick(35);drain();
  }
  assert.equal(audio.context.sources.length,sourceCount);
  assert.equal(audio.stats().activeVoices,0);
  assert.equal(game.state.pieces,0);
  game.move(1);game.move(1);game.drainEvents();
  time+=35;assert.equal(game.softDrop(),true);drain();
  assert.equal(audio.context.sources.length,sourceCount+1);
  assert.equal(played.at(-1),'softdrop');
  time+=35;game.hardDrop();drain();
  assert.equal(game.state.pieces,1);
  assert.ok(played.includes('harddrop'));assert.ok(played.includes('lock'));
});

test('native audio warms once and plays mapped sounds without creating a browser context or buffers', () => {
  const messages=[],created=FakeAudioContext.instances.length;
  const audio=new A.SoundEngine({AudioContext:FakeAudioContext,nativeBridge:{postMessage:message=>messages.push({...message})}});
  audio.configure({volume:37,map:{rotate:'bell',harddrop:'coin'}});
  for(let i=0;i<5;i++)assert.equal(audio.unlock(),true);
  assert.equal(audio.play('rotate'),true);
  assert.equal(audio.play('harddrop'),true);
  assert.equal(audio.preview('laser'),true);
  assert.deepEqual(messages,[{command:'configure',volume:37,enabled:true},{command:'warm'},
    {command:'play',preset:'bell',event:'rotate',volume:37},
    {command:'play',preset:'coin',event:'harddrop',volume:37},
    {command:'play',preset:'laser',event:'preview',volume:37}]);
  assert.equal(FakeAudioContext.instances.length,created);
  assert.equal(audio.context,null);assert.equal(audio.buffers.size,0);
  assert.equal(audio.stats().backend,'native');assert.equal(audio.stats().played,3);
  assert.equal(audio.stats().activeVoices,0,'the browser never duplicates native voices');
});

test('native silence, zero volume and invalid cues post no play command and configuration is immediate', () => {
  const messages=[],audio=new A.SoundEngine({AudioContext:FakeAudioContext,nativeBridge:{postMessage:message=>messages.push({...message})}});
  audio.configure({volume:70,map:{move:'silence',rotate:'digital'}});
  assert.equal(audio.play('move'),false);assert.equal(audio.preview('silence'),false);
  assert.equal(audio.preview('unknown'),false);assert.equal(audio.play('not-an-event'),false);
  audio.configure({volume:0,map:{rotate:'bell'}});
  assert.equal(audio.play('rotate'),false);assert.equal(audio.preview('bell'),false);
  assert.equal(messages.filter(message=>message.command==='play').length,0);
  audio.configure({volume:23,map:{rotate:'rewind'}});
  assert.equal(audio.play('rotate'),true);
  assert.deepEqual(messages.at(-1),{command:'play',preset:'rewind',event:'rotate',volume:23});
  assert.equal(audio.context,null);assert.equal(audio.buffers.size,0);
});

test('native repeated movement uses the 20 ms limit without queuing or suppressing independent actions', async () => {
  let time=100;
  const messages=[],audio=new A.SoundEngine({AudioContext:FakeAudioContext,now:()=>time,nativeBridge:{postMessage:message=>messages.push({...message})}});
  audio.unlock();messages.length=0;
  assert.equal(audio.play('move'),true);time+=19;
  assert.equal(audio.play('move'),false);
  assert.equal(audio.play('rotate'),true);time++;
  assert.equal(audio.play('move'),true);
  assert.equal(audio.play('softdrop'),true);
  assert.equal(messages.length,4,'all accepted cues are posted in their input callback');
  assert.deepEqual(messages.map(message=>message.event),['move','rotate','move','softdrop']);
  for(let i=0;i<100;i++)assert.equal(audio.play('softdrop'),false);
  time+=1000;await Promise.resolve();
  assert.equal(messages.length,4,'suppressed cues never replay later');
  assert.equal(audio.play('softdrop'),true);
  assert.equal(messages.length,5);
  assert.equal(audio.context,null);assert.equal(audio.stats().played,5);
});

test('native contact stops only the requested event and permits a genuine descent immediately', () => {
  const messages=[],audio=new A.SoundEngine({AudioContext:FakeAudioContext,now:()=>100,nativeBridge:{postMessage:message=>messages.push({...message})}});
  audio.configure({map:{softdrop:'victory',rotate:'bell'}});messages.length=0;
  assert.equal(audio.play('softdrop'),true);assert.equal(audio.play('rotate'),true);
  assert.equal(audio.play('softdrop'),false);
  assert.equal(audio.stop('softdrop'),1);
  assert.deepEqual(messages.at(-1),{command:'stop',event:'softdrop'});
  assert.equal(audio.play('softdrop'),true,'contact clears the event repeat limiter');
  assert.equal(messages.filter(message=>message.command==='stop').length,1);
  assert.equal(messages.filter(message=>message.event==='rotate').length,1,'rotation receives no stop command');
  assert.equal(audio.stop(null),0);assert.equal(audio.stop(),0);
  assert.equal(audio.context,null);
});

test('a failed native play falls back during the same input and never retries or duplicates it', async () => {
  const messages=[],bridge={postMessage(message){messages.push({...message});if(message.command==='play')throw new Error('bridge unavailable');}};
  const audio=new A.SoundEngine({AudioContext:FakeAudioContext,nativeBridge:bridge});
  audio.configure({volume:41,map:{harddrop:'bell'}});audio.unlock();
  assert.equal(audio.context,null);
  assert.equal(audio.play('harddrop'),true);
  assert.equal(audio.stats().backend,'webaudio');assert.equal(audio.stats().played,1);
  assert.equal(audio.context.sources.length,1);
  assert.equal(audio.context.sources[0].buffer,audio.buffers.get('bell'));
  assert.deepEqual(audio.context.sources[0].starts,[audio.context.currentTime]);
  assert.equal(audio.master.gain.value,41/100*.23);
  const count=messages.length;
  await Promise.resolve();
  assert.equal(audio.context.sources.length,1,'no pending continuation produces a second sound');
  assert.equal(audio.play('harddrop'),true);
  assert.equal(audio.context.sources.length,2);
  assert.equal(messages.length,count,'a failed bridge is not retried on later inputs');
  assert.equal(messages.filter(message=>message.command==='play').length,1);
});

test('a failed native warm immediately unlocks browser audio with no delayed native retry', () => {
  const messages=[],audio=new A.SoundEngine({AudioContext:FakeAudioContext,nativeBridge:{postMessage(message){messages.push({...message});throw new Error('warm unavailable');}}});
  assert.equal(audio.unlock(),true);
  assert.equal(audio.context.state,'running');
  assert.equal(audio.play('rotate'),true);
  assert.equal(audio.context.sources.length,1);
  assert.deepEqual(messages,[{command:'warm'}]);
  assert.equal(audio.unlock(),true);assert.equal(audio.context.sources.length,1);
  assert.equal(messages.length,1);
});

function nativeAudioRealm(options={}) {
  const listeners=new Map(),messages=[];
  const sandbox={module:{exports:{}},PixelNativeAudio:options.nativeFlag!==false,
    AudioContext:Object.hasOwn(options,'AudioContext')?options.AudioContext:FakeAudioContext,
    webkit:{messageHandlers:{pixelAudio:{postMessage:message=>messages.push({...message})}}},
    addEventListener:(name,callback)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(callback);}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../audio.js'),'utf8'),sandbox,{filename:'audio.js'});
  return {A:sandbox.module.exports,messages,
    dispatch(name){for(const callback of listeners.get(name)||[])callback({type:name});}};
}

test('native unavailable notification unlocks browser fallback without replaying the failed cue', () => {
  const realm=nativeAudioRealm(),audio=new realm.A.SoundEngine({now:()=>100});
  audio.configure({volume:32,map:{softdrop:'bell'}});audio.unlock();
  assert.equal(audio.play('softdrop'),true);
  assert.equal(audio.context,null);assert.equal(audio.stats().played,1);
  const messageCount=realm.messages.length;
  realm.dispatch('pixelAudioUnavailable');
  assert.equal(audio.stats().backend,'webaudio');
  assert.equal(audio.context.state,'running');
  assert.equal(audio.context.sources.length,0,'the failed native cue is never queued for delayed playback');
  assert.equal(audio.stats().played,1);
  assert.equal(audio.master.gain.value,32/100*.23);
  assert.equal(audio.play('softdrop'),true,'the next input remains audible at the same repeat timestamp');
  assert.equal(audio.context.sources.length,1);
  assert.equal(audio.context.sources[0].buffer,audio.buffers.get('bell'));
  assert.deepEqual(audio.context.sources[0].starts,[audio.context.currentTime]);
  assert.equal(realm.messages.length,messageCount,'the unavailable native backend receives no retry');
  const context=audio.context;
  realm.dispatch('pixelAudioUnavailable');
  assert.equal(audio.context,context);assert.equal(context.sources.length,1,'repeated notifications cannot double-play');
});

test('native unavailable without browser audio is a safe no-op and ordinary browsers ignore an unmarked bridge', () => {
  const realm=nativeAudioRealm({AudioContext:undefined}),audio=new realm.A.SoundEngine();
  assert.equal(audio.unlock(),true);
  realm.dispatch('pixelAudioUnavailable');
  const messageCount=realm.messages.length;
  assert.equal(audio.unlock(),false);assert.equal(audio.play('harddrop'),false);
  assert.equal(realm.messages.length,messageCount);
  assert.equal(audio.stats().available,false);
  const browserRealm=nativeAudioRealm({nativeFlag:false}),browserAudio=new browserRealm.A.SoundEngine();
  assert.equal(browserAudio.unlock(),true);assert.equal(browserAudio.play('rotate'),true);
  assert.equal(browserAudio.stats().backend,'webaudio');
  assert.equal(browserRealm.messages.length,0,'native IPC is used only in the marked desktop runtime');
});

test('disabled startup and background audio allocate no browser graph and prepare before the next key', () => {
  const created=FakeAudioContext.instances.length;
  const audio=new A.SoundEngine({AudioContext:FakeAudioContext,enabled:false});
  audio.configure({volume:60});
  assert.equal(audio.unlock(),false);assert.equal(audio.play('rotate'),false);assert.equal(audio.preview('bell'),false);
  assert.equal(FakeAudioContext.instances.length,created);
  audio.setActive(false);audio.setEnabled(true);
  assert.equal(audio.unlock(),false);assert.equal(audio.context,null);
  audio.setActive(true);
  const context=audio.context;
  assert.equal(context.state,'running');assert.equal(context.buffers.length,21);
  assert.equal(audio.play('rotate'),true);
  assert.deepEqual(context.sources[0].starts,[context.currentTime]);
  const zeroVolume=new A.SoundEngine({AudioContext:FakeAudioContext});
  zeroVolume.configure({volume:0});assert.equal(zeroVolume.context,null);
  zeroVolume.configure({volume:50});
  assert.equal(zeroVolume.context.state,'running','raising volume prewarms before the next cue');
  assert.equal(zeroVolume.context.sources.length,0);
});

test('muting and rapid background switches keep cached PCM, discard old tails, and never leave browser audio suspended', () => {
  const audio=new A.SoundEngine({AudioContext:FakeAudioContext,now:()=>100});
  audio.unlock();audio.play('softdrop');
  const context=audio.context,oldSource=context.sources[0],oldBuffer=audio.buffers.get('tick');
  // All calls precede the first resume promise's microtask settlement.
  audio.setActive(false);audio.setActive(true);
  assert.equal(audio.context,context);assert.equal(context.state,'running');
  assert.equal(context.buffers.length,21);assert.equal(audio.buffers.get('tick'),oldBuffer);
  assert.equal(oldSource.disconnected,true);assert.equal(oldSource.onended,null);
  assert.deepEqual(oldSource.stops,[context.currentTime]);
  assert.equal(audio.stats().activeVoices,0);
  assert.equal(audio.play('softdrop'),true,'a real descent after wake bypasses the old repeat timestamp');
  audio.setEnabled(false);
  assert.equal(context.state,'suspended');assert.equal(audio.play('rotate'),false);assert.equal(audio.preview('bell'),false);
  audio.setActive(false);audio.setActive(true);
  assert.equal(context.state,'suspended','foreground must not override disabled sound');
  audio.setEnabled(true);
  assert.equal(context.state,'running');assert.equal(audio.stats().activeVoices,0);
  assert.equal(audio.play('harddrop'),true);assert.equal(context.sources.length,3);
  assert.equal(context.resumeCount,3,'each explicit wake prewarms without relying on play');
  audio.configure({volume:0});assert.equal(context.state,'suspended');
  audio.configure({volume:55});assert.equal(context.state,'running');
  assert.equal(context.buffers.length,21);assert.equal(audio.stats().activeVoices,0);
});

test('native lifecycle gates every cue and preview while muted or backgrounded, and warms on explicit foreground entry', () => {
  const messages=[],audio=new A.SoundEngine({AudioContext:FakeAudioContext,enabled:false,nativeBridge:{postMessage:message=>messages.push({...message})}});
  audio.configure({volume:37});
  assert.deepEqual(messages,[{command:'configure',volume:37,enabled:false}]);
  assert.equal(audio.unlock(),false);assert.equal(audio.play('rotate'),false);assert.equal(audio.preview('bell'),false);
  audio.setActive(false);audio.setEnabled(true);
  assert.equal(messages.filter(message=>message.command==='warm').length,0);
  assert.equal(audio.play('rotate'),false);
  audio.setActive(true);
  assert.deepEqual(messages.slice(-2),[{command:'configure',volume:37,enabled:true},{command:'warm'}]);
  assert.equal(audio.play('rotate'),true);
  audio.setEnabled(false);
  assert.deepEqual(messages.at(-1),{command:'configure',volume:37,enabled:false});
  assert.equal(audio.play('rotate'),false);assert.equal(audio.preview('bell'),false);
  audio.setEnabled(true);
  assert.deepEqual(messages.slice(-2),[{command:'configure',volume:37,enabled:true},{command:'warm'}]);
  assert.equal(audio.play('rotate'),true);
  assert.equal(messages.filter(message=>message.command==='play').length,2);
  assert.equal(audio.context,null);assert.equal(audio.buffers.size,0);
});

test('a native failure while muted does not create an audio fallback until it is explicitly enabled', () => {
  const realm=nativeAudioRealm(),audio=new realm.A.SoundEngine({enabled:false});
  audio.configure({volume:32});
  realm.dispatch('pixelAudioUnavailable');
  assert.equal(audio.context,null);assert.equal(audio.unlock(),false);
  audio.setActive(false);audio.setEnabled(true);
  assert.equal(audio.context,null);
  audio.setActive(true);
  assert.equal(audio.context.state,'running');assert.equal(audio.context.sources.length,0);
  assert.equal(audio.play('harddrop'),true);assert.equal(audio.context.sources.length,1);
});
