const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
process.chdir(path.resolve(__dirname,'../..'));
const results=process.env.OUTPUT || 'docs/performance/phase2/results';fs.mkdirSync(results,{recursive:true});
const checks=[
  ['Build',['node_modules/@nestjs/cli/bin/nest.js','build']],
  ['Resolve aliases',['node_modules/tsc-alias/dist/bin/index.js']],
  ['Unit',['node_modules/jest/bin/jest.js','--runInBand','--json',`--outputFile=${results}/unit.json`]],
  ['Integration (real PostgreSQL)',['node_modules/jest/bin/jest.js','--config','jest.integration.config.js','--runInBand','--json',`--outputFile=${results}/integration.json`]],
  ['HTTP and persistence',['--test','--test-concurrency=1','test/e2e/phase2-retry-policy.e2e.cjs','test/e2e/phase2-telemetry.e2e.cjs','test/e2e/phase2-persistence.e2e.cjs','test/e2e/transfer-admission.e2e.cjs','test/e2e/banking-http.e2e.cjs']],
  ['Swagger',['test/swagger.contract.cjs']],
  ...(process.env.SKIP_HISTORICAL_COMPARISON === '1' ? [] : [['Before/after reliability',['scripts/phase2/check-idempotency.cjs']]]),
];
const log=[];
for(const [label,args]of checks){
  const start=Date.now();
  const result=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  const output=(result.stdout||'')+'\n'+(result.stderr||'');
  if(result.status!==0){log.push(`FAIL: ${label}\n${output}`);fs.writeFileSync(`${results}/validation.txt`,log.join('\n\n'));console.error(log.at(-1));process.exit(1);}
  log.push(`PASS: ${label} (${Date.now()-start} ms)\n${output}`);
  fs.writeFileSync(`${results}/validation.txt`,log.join('\n\n'));console.log(`PASS: ${label}`);
}
