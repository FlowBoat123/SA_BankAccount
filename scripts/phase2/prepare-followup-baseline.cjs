// Run after npm run build. Same compiled tree, replace only the transfer use case
// with the pinned phase-2 source. All telemetry/UoW/schema stays identical.
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const commit='8ad478154e3772eb60e08cc8a741b087843dd35f';
const relative='modules/money-movement/application/use-cases/transfer-money.use-case';
const source=execFileSync('git',['show',`${commit}:src/${relative}.ts`],{cwd:root,encoding:'utf8'});
const config=ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile);
if(config.error)throw Error(ts.flattenDiagnosticMessageText(config.error.messageText,'\n'));
const compilerOptions=ts.convertCompilerOptionsFromJson(config.config.compilerOptions,root).options;
const {outputText,diagnostics}=ts.transpileModule(source,{compilerOptions,fileName:path.join(root,'src',relative+'.ts'),reportDiagnostics:true});
if(diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error))
  throw Error(diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')).join('\n'));
const target=path.join(root,'.phase2/followup-baseline-dist');
fs.cpSync(path.join(root,'dist'),target,{recursive:true});
fs.writeFileSync(path.join(target,relative+'.js'),outputText);
console.log('Prepared pinned phase-2 transfer flow with identical telemetry/UoW.');
