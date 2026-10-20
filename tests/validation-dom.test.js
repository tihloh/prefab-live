'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../assets/prefab-live.js'),'utf8');

test('text validation does not replace the active form DOM',()=>{
  assert.match(source,/preserveDom:\s*textValidation/);
  assert.match(source,/if\s*\(!options\.preserveDom\)\s*\{\s*replaceContentPreservingFocus\(/);
  assert.match(source,/mergeErrors\(root,\s*data,\s*Boolean\(action\)\)/);
  assert.match(source,/root\.setAttribute\('pf:snapshot'/);
  assert.match(source,/renderErrors\(root\)/);
});
test('text model requests validate only their field and keep structural controls reactive',()=>{
  assert.match(source,/validate:\s*\[directive\.path\]/);
  assert.match(source,/element instanceof HTMLTextAreaElement/);
  assert.match(source,/element instanceof HTMLInputElement/);
  assert.match(source,/\['checkbox','radio','file','hidden','date','datetime-local','time','month','week'\]/);
});
