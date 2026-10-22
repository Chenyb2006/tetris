'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {build}=require('../build-sounds.js');
const A=require('../audio.js');

class ReferenceContext {
  constructor(){this.sampleRate=48000;this.currentTime=0;this.state='running';this.destination={};}
  createBuffer(channels,length,sampleRate){
    const samples=new Float32Array(length);
    return {channels,length,sampleRate,getChannelData:()=>samples};
  }
  createGain(){return {gain:{setValueAtTime(){}},connect(){}};}
}

test('native assets contain every audible preset as deterministic 48 kHz mono PCM16 WAV', t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tetris-native-sounds-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const first=path.join(directory,'first'),second=path.join(directory,'second');
  const expected=A.PRESETS.filter(preset=>preset.id!=='silence').map(preset=>preset.id);
  assert.equal(build(first),21);assert.equal(build(second),21);
  assert.equal(expected.length,21);
  const manifest=JSON.parse(fs.readFileSync(path.join(first,'presets.json'),'utf8'));
  assert.deepEqual(manifest,expected);
  assert.deepEqual(fs.readdirSync(first).sort(),['presets.json',...expected.map(id=>id+'.wav')].sort());
  const reference=new A.SoundEngine({AudioContext:ReferenceContext});
  assert.equal(reference.unlock(),true);
  for(const id of manifest){
    const file=fs.readFileSync(path.join(first,id+'.wav'));
    assert.deepEqual(file,fs.readFileSync(path.join(second,id+'.wav')),id+' renders reproducibly');
    assert.equal(file.toString('ascii',0,4),'RIFF',id);
    assert.equal(file.readUInt32LE(4),file.length-8,id);
    assert.equal(file.toString('ascii',8,16),'WAVEfmt ',id);
    assert.equal(file.readUInt32LE(16),16,id);
    assert.equal(file.readUInt16LE(20),1,id+' uses uncompressed PCM');
    assert.equal(file.readUInt16LE(22),1,id+' uses one channel');
    assert.equal(file.readUInt32LE(24),48000,id);
    assert.equal(file.readUInt32LE(28),96000,id);
    assert.equal(file.readUInt16LE(32),2,id);
    assert.equal(file.readUInt16LE(34),16,id);
    assert.equal(file.toString('ascii',36,40),'data',id);
    assert.equal(file.readUInt32LE(40),file.length-44,id);
    assert.equal((file.length-44)%2,0,id);
    const samples=reference.buffers.get(id).getChannelData(0);
    assert.equal(file.length,44+samples.length*2,id+' has the same duration as the browser sound');
    let onset=-1,peak=0;
    for(let index=0;index<samples.length;index++){
      const value=file.readInt16LE(44+index*2);
      assert.equal(value,Math.round(Math.max(-1,Math.min(1,samples[index]))*32767)||0,id+' preserves the shared waveform at sample '+index);
      if(onset<0&&value!==0)onset=index;
      peak=Math.max(peak,Math.abs(value));
    }
    assert.equal(file.readInt16LE(44),0,id+' starts without a discontinuity');
    assert.equal(file.readInt16LE(file.length-2),0,id+' releases to silence');
    assert.ok(onset>0&&onset/48000<.001,id+' starts in less than 1 ms');
    assert.ok(peak<=Math.ceil(.44*32767)&&peak>.439*32767,id+' retains mixing headroom');
  }
});
