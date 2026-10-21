import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('Windows launcher works with PATH Node and bundled Node in a spaced home', {skip:process.platform!=='win32'},()=>{
 const root=mkdtempSync(join(tmpdir(),'local downloads '));
 try {
  const launcher=join(root,'download-models.cmd');copyFileSync(resolve('download-models.cmd'),launcher);
  const env={...process.env,USERPROFILE:join(root,'user home')};
  mkdirSync(env.USERPROFILE,{recursive:true});
  const run=()=>spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`""${launcher}" --help"`],{env,encoding:'utf8',windowsVerbatimArguments:true,timeout:15000});
  let result=run();assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/Read-only plan/);
  const bundled=join(env.USERPROFILE,'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','bin');
  mkdirSync(bundled,{recursive:true});copyFileSync(process.execPath,join(bundled,'node.exe'));
  env.PATH=process.env.SystemRoot+'\\System32';
  result=run();assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/Read-only plan/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
