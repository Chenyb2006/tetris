'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const root = __dirname;
const output = path.join(root, 'dist');
execFileSync(process.execPath, [path.join(root, 'build-coach-worker.js')]);
fs.rmSync(output, {recursive: true, force: true});
fs.mkdirSync(output, {recursive: true});
// Only these public runtime assets enter the website; never copy the workspace.
for (const file of ['index.html', 'styles.css', 'engine.js', 'audio.js', 'effects.js',
  'app.js', 'coach.js', 'coach-client.js', 'coach-worker.js', 'coach-worker-source.js', 'icon.svg']) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
fs.cpSync(path.join(root, 'assets/fonts'), path.join(output, 'assets/fonts'), {
  recursive: true,
  filter: source => !['update_subset.py', 'characters.txt'].includes(path.basename(source))
});
fs.writeFileSync(path.join(output, '.nojekyll'), '');
// New releases must not reuse browser-cached scripts from a previous release.
const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8').replace(
  /((?:src|href)=")([^"?]+\.(?:js|css))(")/g,
  (_, prefix, file, suffix) => {
    const version = createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex').slice(0, 12);
    return `${prefix}${file}?v=${version}${suffix}`;
  });
fs.writeFileSync(path.join(output, 'index.html'), html);
console.log('网页版已生成：dist/');
