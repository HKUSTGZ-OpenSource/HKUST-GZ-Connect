'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const test = require('node:test');
const repository = path.resolve(__dirname,'../../../../..');

test('native C source checkout preserves LF bytes even with Windows-style Git defaults',t=>{
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hkustgz-native-source-eol-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const git = args=>execFileSync('git',args,{cwd:root,stdio:'pipe',timeout:10000});
  git(['init','-q']);
  fs.copyFileSync(path.join(repository,'.gitattributes'),path.join(root,'.gitattributes'));
  const relative = 'desktop/lib/platform/storage/native/windows-private-file.c';
  const file = path.join(root,relative);
  const expected = Buffer.from('/* synthetic native source */\nint main(void) { return 0; }\n');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,expected);
  git(['add','--','.gitattributes',relative]);
  for (const [autocrlf,eol] of [['false','crlf'],['true','crlf'],['input','lf']]) {
    git(['config','--local','core.autocrlf',autocrlf]);git(['config','--local','core.eol',eol]);
    fs.unlinkSync(file);git(['checkout-index','--',relative]);
    assert.deepEqual(fs.readFileSync(file),expected,`autocrlf=${autocrlf}, eol=${eol}`);
  }
});
