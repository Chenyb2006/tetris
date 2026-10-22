/* Render the same original browser sound library to native PCM assets at build time. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./audio.js');

class BuildContext {
  constructor() { this.sampleRate = 48000; this.currentTime = 0; this.state = 'running'; this.destination = {}; }
  createBuffer(channels, length, sampleRate) {
    const samples = new Float32Array(length);
    return {sampleRate, getChannelData:() => samples};
  }
  createGain() { return {gain:{setValueAtTime(){}},connect(){}}; }
}

function wave(buffer) {
  const samples = buffer.getChannelData(0), result = Buffer.alloc(44 + samples.length * 2);
  result.write('RIFF',0); result.writeUInt32LE(result.length - 8,4); result.write('WAVEfmt ',8);
  result.writeUInt32LE(16,16); result.writeUInt16LE(1,20); result.writeUInt16LE(1,22);
  result.writeUInt32LE(buffer.sampleRate,24); result.writeUInt32LE(buffer.sampleRate * 2,28);
  result.writeUInt16LE(2,32); result.writeUInt16LE(16,34); result.write('data',36);
  result.writeUInt32LE(samples.length * 2,40);
  for (let i = 0; i < samples.length; i++) result.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i])) * 32767),44 + i * 2);
  return result;
}

function build(destination) {
  fs.mkdirSync(destination,{recursive:true});
  const sound = new A.SoundEngine({AudioContext:BuildContext});
  if (!sound.unlock()) throw Error('Cannot render native sounds');
  for (const [id,buffer] of sound.buffers) fs.writeFileSync(path.join(destination,id + '.wav'),wave(buffer));
  fs.writeFileSync(path.join(destination,'presets.json'),JSON.stringify([...sound.buffers.keys()]));
  return sound.buffers.size;
}
if (require.main === module) {
  const destination = process.argv[2] || path.join(__dirname,'desktop','.build','sounds');
  process.stdout.write(`Native sounds prepared: ${build(destination)}\n`);
}
module.exports = {build};
