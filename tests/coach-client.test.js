'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {Controller} = require('../coach-client.js');

class FakeWorker {
  static instances = [];
  constructor(url) {this.url = url; this.messages = []; this.terminated = false; FakeWorker.instances.push(this);}
  postMessage(message) {this.messages.push(message);}
  terminate() {this.terminated = true;}
  respond(result, id = this.messages.at(-1).id) {this.onmessage?.({data: {id, result}});}
}
function setup(options = {}) {
  const results = [], errors = [], statuses = [];
  const controller = new Controller({Worker: FakeWorker, onResult:(...args) => results.push(args),
    onError:(...args) => errors.push(args), onStatus:status => statuses.push(status), ...options});
  return {controller, results, errors, statuses};
}

test('coach starts lazily, snapshots input, and reports results with the position key', () => {
  const {controller, results, statuses} = setup();
  assert.equal(controller.worker, null);
  const view = {board:[[null]], active:{x:3}};
  assert.equal(controller.request(view, 'a'), true);
  const worker = controller.worker;
  assert.equal(worker.url, 'coach-worker.js');
  assert.equal(controller.status, 'thinking');
  view.board[0][0] = 'T';
  assert.equal(worker.messages[0].view.board[0][0], null);
  worker.respond({placement: {x:0}});
  assert.deepEqual(results, [[{placement:{x:0}}, 'a']]);
  assert.equal(controller.status, 'idle');
  assert.deepEqual(statuses, ['thinking','idle']);
  assert.equal(controller.request(view, 'a'), false);
  controller.destroy();
});

test('busy requests coalesce to the latest position and never deliver stale results', () => {
  const {controller, results} = setup();
  controller.request({state:'a'}, 'a');
  const worker = controller.worker;
  controller.request({state:'b'}, 'b');
  controller.request({state:'c'}, 'c');
  assert.equal(worker.messages.length, 1);
  assert.equal(controller.request({state:'c'}, 'c'), false);
  worker.respond({state:'old'});
  assert.equal(results.length, 0);
  assert.equal(worker.messages.length, 2);
  assert.equal(worker.messages[1].view.state, 'c');
  worker.respond({state:'wrong'}, worker.messages[0].id);
  assert.equal(results.length, 0);
  worker.respond({state:'new'});
  assert.deepEqual(results, [[{state:'new'}, 'c']]);
  controller.destroy();
});

test('returning to the inflight position discards the no-longer-needed queued position', () => {
  const {controller, results} = setup();
  controller.request({}, 'a');
  const worker = controller.worker;
  controller.request({}, 'b');
  controller.request({}, 'a');
  worker.respond('a');
  assert.deepEqual(results, [['a','a']]);
  assert.equal(worker.messages.length, 1);
  controller.destroy();
});

test('cancel terminates ongoing search, ignores late callbacks, and allows a fresh worker', () => {
  const {controller, results} = setup();
  controller.request({}, 'a');
  const first = controller.worker, lateMessage = first.onmessage;
  controller.request({}, 'b');
  controller.cancel();
  assert.equal(first.terminated, true);
  assert.equal(controller.status, 'idle');
  assert.equal(controller.pending, null);
  controller.request({}, 'c');
  const next = controller.worker;
  assert.notEqual(next, first);
  lateMessage({data:{id:first.messages[0].id, result:'old'}});
  assert.equal(results.length, 0);
  next.respond('fresh');
  assert.deepEqual(results, [['fresh','c']]);
  controller.destroy();
  assert.equal(next.terminated, true);
  assert.equal(controller.status, 'destroyed');
  assert.equal(controller.request({}, 'd'), false);
});

test('worker errors release resources and retry only after explicitly cancelled', () => {
  const {controller, errors} = setup();
  controller.request({}, 'a');
  const worker = controller.worker;
  let prevented = false;
  worker.onerror({message:'cannot start', preventDefault:()=>{prevented = true;}});
  assert.equal(prevented, true);
  assert.equal(worker.terminated, true);
  assert.equal(controller.status, 'unavailable');
  assert.equal(errors[0][0].message, 'cannot start');
  assert.equal(controller.request({}, 'b'), false);
  controller.cancel();
  assert.equal(controller.request({}, 'b'), true);
  controller.destroy();
});

test('stale search errors do not hide a queued valid position', () => {
  const {controller, errors, results} = setup();
  controller.request({}, 'a');
  const worker = controller.worker;
  controller.request({}, 'b');
  worker.onmessage({data:{id:worker.messages[0].id, error:'old invalid state'}});
  assert.equal(errors.length, 0);
  assert.equal(worker.messages.length, 2);
  worker.respond('valid');
  assert.deepEqual(results, [['valid','b']]);
  controller.destroy();
});

test('current search exceptions surface cleanly; unavailable Worker never searches on main thread', () => {
  const {controller, errors} = setup();
  controller.request({}, 'a');
  controller.worker.onmessage({data:{id:controller.worker.messages[0].id, error:'invalid position'}});
  assert.equal(controller.status, 'unavailable');
  assert.equal(errors[0][0].message, 'invalid position');
  const missing = setup({Worker:null});
  assert.equal(missing.controller.request({}, 'a'), false);
  assert.match(missing.errors[0][0].message, /后台计算/);
  assert.equal(missing.controller.worker, null);
  const throwing = setup({Worker:class {constructor() {throw new Error('blocked');}}});
  assert.equal(throwing.controller.request({}, 'a'), false);
  assert.equal(throwing.errors[0][0].message, 'blocked');
});

test('bundled Blob workers need no file fetch and object URLs are released on cancel and startup failure', () => {
  const created = [], revoked = [];
  class FakeBlob {constructor(parts, options) {this.parts = parts; this.options = options;}}
  const url = {createObjectURL(blob) {created.push(blob); return 'blob:test-'+created.length;}, revokeObjectURL(value) {revoked.push(value);}};
  const {controller} = setup({Blob:FakeBlob, URL:url, workerSource:'/* offline engine + coach */'});
  controller.request({}, 'a');
  assert.equal(controller.worker.url, 'blob:test-1');
  assert.deepEqual(created[0].parts, ['/* offline engine + coach */']);
  assert.equal(created[0].options.type, 'text/javascript');
  controller.cancel();
  assert.deepEqual(revoked, ['blob:test-1']);
  const failed = setup({Blob:FakeBlob, URL:url, workerSource:'bundle', Worker:class {constructor() {throw new Error('blocked');}}});
  failed.controller.request({}, 'a');
  assert.deepEqual(revoked, ['blob:test-1','blob:test-2']);
});

test('a result callback may cancel or request a new search without starting the old pending work', () => {
  let controller;
  controller = new Controller({Worker:FakeWorker, onResult:()=>{controller.cancel(); controller.request({}, 'b');}});
  controller.request({}, 'a');
  const first = controller.worker;
  first.respond('a');
  assert.equal(first.terminated, true);
  assert.equal(controller.worker.messages.length, 1);
  assert.equal(controller.inflight.key, 'b');
  controller.destroy();
});

test('worker uses preloaded engine and coach; returns request ids and caught errors', () => {
  const messages = [], imports = [];
  const scope = {PixelEngine:{}, PixelCoachCore:{analyze:(view, options)=>({view, options})},
    importScripts:path=>imports.push(path), postMessage:message=>messages.push(message)};
  vm.runInNewContext(fs.readFileSync(require.resolve('../coach-worker.js'),'utf8'), {self:scope});
  scope.onmessage({data:{id:7, view:{a:1}, options:{depth:2}}});
  assert.equal(imports.length, 0);
  assert.equal(messages[0].id, 7);
  assert.equal(messages[0].result.view.a, 1);
  assert.equal(messages[0].result.options.depth, 2);
  scope.PixelCoachCore.analyze = () => {throw new Error('invalid view');};
  scope.onmessage({data:{id:8}});
  assert.equal(messages[1].id, 8);
  assert.equal(messages[1].error, 'invalid view');
});

test('static worker imports its dependencies once at startup', () => {
  const imports = [], scope = {importScripts:path=>imports.push(path)};
  vm.runInNewContext(fs.readFileSync(require.resolve('../coach-worker.js'),'utf8'), {self:scope});
  assert.deepEqual(imports, ['engine.js','coach.js']);
});
