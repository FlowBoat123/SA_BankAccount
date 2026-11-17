// Build a detached, pinned source snapshot using the same installed dependencies.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const commit = 'c347c921d77ba533cfacd8e180feccef720be013';
const source = path.join(root, '.phase2/baseline-source');
const output = path.join(root, '.phase2/baseline-dist');
function run(cmd,args,cwd=root){execFileSync(cmd,args,{cwd,stdio:'inherit',windowsHide:true});}
fs.mkdirSync(path.dirname(source),{recursive:true});
if (!fs.existsSync(source)) run('git',['worktree','add','--detach',source,commit]);
const actual=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
if(actual!==commit)throw Error('Unexpected baseline worktree revision');
if(!fs.existsSync(path.join(source,'node_modules')))fs.symlinkSync(path.join(root,'node_modules'),path.join(source,'node_modules'),process.platform==='win32'?'junction':'dir');
run(process.execPath,[path.join(root,'node_modules/@nestjs/cli/bin/nest.js'),'build'],source);
run(process.execPath,[path.join(root,'node_modules/tsc-alias/dist/bin/index.js')],source);
fs.mkdirSync(output,{recursive:true});
fs.cpSync(path.join(source,'dist'),output,{recursive:true});
console.log('Baseline built at',commit);
