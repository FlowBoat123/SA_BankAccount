// Compare phase-2 two-lock-query flow against one ordered locking query.
// Dedicated *_test DB only. The baseline has the SAME telemetry/schema/runtime.
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const {once}=require('node:events');
const {randomUUID,createHash}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Client}=require('pg');const jwt=require('jsonwebtoken');
const root=path.resolve(__dirname,'../..');
const url=process.env.DATABASE_URL;
if(!url || !new URL(url).pathname.endsWith('_test'))throw Error('Dedicated *_test database required');
const output=path.resolve(root,process.env.OUTPUT||'docs/performance/phase2-followup/results');
const rounds=Number(process.env.ROUNDS||3),duration=Number(process.env.DURATION||20);
assert.ok(Number.isInteger(rounds)&&rounds>0&&Number.isFinite(duration)&&duration>0,'Positive rounds/duration required');
const baseline=path.resolve(root,process.env.BASELINE_DIST||'.phase2/followup-baseline-dist');
const profiles = {
  baseline: { TRANSFER_ADMISSION: 'off', TRANSFER_COMPACT_WRITE: 'off' },
  global: { TRANSFER_ADMISSION: 'global', TRANSFER_COMPACT_WRITE: 'off' },
  account: { TRANSFER_ADMISSION: 'account', TRANSFER_COMPACT_WRITE: 'off' },
  compact: { TRANSFER_ADMISSION: 'off', TRANSFER_COMPACT_WRITE: 'on' },
  combined: { TRANSFER_ADMISSION: 'account', TRANSFER_COMPACT_WRITE: 'on' },
};
const selectedProfiles = process.env.TRANSFER_PROFILES?.split(',');
if (selectedProfiles) {
  assert.ok(selectedProfiles.every(name => Object.hasOwn(profiles, name)), 'Unknown transfer profile');
  assert.equal(new Set(selectedProfiles).size, selectedProfiles.length, 'Duplicate transfer profile');
}
const db=new Client({connectionString:url}),sampler=new Client({connectionString:url});
const runId=randomUUID(),user=randomUUID(),ids=Array.from({length:20},()=>randomUUID());
const numbers=ids.map((_,i)=>`F${runId.slice(0,8)}${i}`),initial=1000000000n;
const secret='followup-benchmark-only-secret',token=jwt.sign({sub:user,email:'benchmark@example.test'},secret,{expiresIn:'2h'});
let child,log='',seq=0;const rows=[];

function ipc(command){
  return new Promise((resolve,reject)=>{
    const id=++seq;const timer=setTimeout(()=>{child.off('message',onMessage);reject(Error('IPC timeout'));},10000);
    function onMessage(message){if(message.id===id){clearTimeout(timer);child.off('message',onMessage);resolve(message);}}
    child.on('message',onMessage);child.send({id,command});
  });
}
async function start(dist, profile={}){
  const connection=new URL(url);connection.searchParams.set('application_name','phase2-followup-api');log='';
  child=spawn(process.execPath,['scripts/phase2/diagnostic-server.cjs',dist],{cwd:root,
    env:{...process.env,DATABASE_URL:connection.toString(),PORT:'3318',NODE_ENV:'production',JWT_ACCESS_SECRET:secret,JWT_ACCESS_TTL:'2h',BCRYPT_ROUNDS:'12',...profile},
    stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  for(const stream of [child.stdout,child.stderr])stream.on('data',c=>{log=(log+c).slice(-100000);});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Start timeout: '+log)),30000);
    child.once('error',reject);child.once('exit',code=>{clearTimeout(timeout);reject(Error('API exited '+code+': '+log));});
    child.on('message',message=>{if(message.ready){clearTimeout(timeout);resolve();}});
  });
}
async function stop(){
  if(child&&child.exitCode===null){
    const exited=once(child,'exit');child.send({command:'close'});
    const timer=setTimeout(()=>child.kill(),5000);try{await exited;}finally{clearTimeout(timer);}
  }child=null;
}
async function reset(){
  await db.query('DELETE FROM financial_transactions WHERE account_id=ANY($1::text[])',[ids]);
  await db.query('DELETE FROM transfers WHERE source_account_id=ANY($1::text[])',[ids]);
  await db.query('UPDATE bank_accounts SET current_balance=$2::numeric WHERE id=ANY($1::text[])',[ids,initial.toString()]);
}
async function reconcile(successes){
  const accounts=(await db.query('SELECT current_balance::text balance FROM bank_accounts WHERE id=ANY($1::text[])',[ids])).rows;
  assert.equal(accounts.reduce((sum,a)=>sum+BigInt(a.balance),0n),initial*20n);
  assert.ok(accounts.every(a=>BigInt(a.balance)>=0n));
  const transfers=(await db.query('SELECT count(*)::int n FROM transfers WHERE source_account_id=ANY($1::text[])',[ids])).rows[0].n;
  const entries=(await db.query('SELECT count(*)::int n FROM financial_transactions WHERE account_id=ANY($1::text[])',[ids])).rows[0].n;
  assert.equal(transfers,successes);assert.equal(entries,successes*2);
  const mismatch=(await db.query(`SELECT count(*)::int n FROM (
    SELECT a.id FROM bank_accounts a LEFT JOIN financial_transactions f ON a.id=f.account_id
    WHERE a.id=ANY($1::text[]) GROUP BY a.id,a.current_balance
    HAVING a.current_balance<>$2::numeric+coalesce(sum(CASE WHEN f.transaction_type='CREDIT' THEN f.amount ELSE -f.amount END),0)
  ) q`,[ids,initial.toString()])).rows[0].n;
  assert.equal(mismatch,0);return{transfers,ledgerEntries:entries,conserved:true,ledgerMatchesBalances:true};
}
async function load(scenario,seconds){
  let success=0;const errors={},latencies=[],successfulLatencies=[];const began=performance.now(),deadline=began+seconds*1000;
  await Promise.all(Array.from({length:scenario.clients},async(_,client)=>{
    while(performance.now()<deadline){
      const pair=scenario.distributed?client:0,start=performance.now();
      try{
        const response=await fetch('http://127.0.0.1:3318/api/v1/transfers',{method:'POST',signal:AbortSignal.timeout(15000),
          headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},
          body:JSON.stringify({sourceAccountId:ids[pair*2],destinationAccountNumber:numbers[pair*2+1],amount:'1'})});
        const body=await response.json();
        if(response.status!==201)throw Error(`${response.status}:${body.error?.code}`);
        assert.equal(body.data.sourceAccountId,ids[pair*2]);assert.equal(body.data.destinationAccountId,ids[pair*2+1]);assert.equal(body.data.amount,'1');success++;
        successfulLatencies.push(performance.now()-start);
      }catch(error){const key=error.message.slice(0,160);errors[key]=(errors[key]||0)+1;}
      latencies.push(performance.now()-start);
    }
  }));
  const elapsed=(performance.now()-began)/1000;latencies.sort((a,b)=>a-b);
  const p=q=>latencies[Math.min(latencies.length-1,Math.ceil(q*latencies.length)-1)];
  successfulLatencies.sort((a,b)=>a-b);
  const successPercentile=q=>successfulLatencies[Math.ceil(q*successfulLatencies.length)-1]??null;
  return{seconds:elapsed,requests:latencies.length,successes:success,errors,successRps:success/elapsed,
    p50:p(.5),p95:p(.95),p99:p(.99),successP95:successPercentile(.95),successP99:successPercentile(.99)};
}
async function sqlStats(){
  return(await db.query(`SELECT queryid::text,query,calls::text,total_exec_time,rows::text
    FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND (query ILIKE '%bank_accounts%' OR query ILIKE '%financial_transactions%' OR query ILIKE '%transfers%')`)).rows;
}
function sqlDiff(before,after){
  const previous=new Map(before.map(r=>[r.queryid,r]));return after.map(row=>{
    const old=previous.get(row.queryid);return{queryId:row.queryid,normalizedQuery:row.query,calls:Number(row.calls)-Number(old?.calls||0),
      executionMs:row.total_exec_time-(old?.total_exec_time||0),rows:Number(row.rows)-Number(old?.rows||0)};
  }).filter(row=>row.calls>0);
}
async function measured(scenario){
  let done=false,pollError;const samples=[];
  const polling=(async()=>{
    while(!done){
      const row=(await sampler.query(`SELECT count(*)::int sessions,
        count(*) FILTER(WHERE wait_event_type='Lock')::int "waitingOnLock",
        count(*) FILTER(WHERE state='active')::int active
        FROM pg_stat_activity WHERE application_name='phase2-followup-api'`)).rows[0];
      assert.ok(Number.isFinite(row.waitingOnLock)&&row.sessions>0,'Invalid lock sampling row');
      samples.push(row);await new Promise(ok=>setTimeout(ok,50));
    }
  })().catch(error=>{pollError=error;});
  try{return{metrics:await load(scenario,duration),samples};}
  finally{done=true;await polling;if(pollError)throw pollError;}
}
async function main(){
  fs.mkdirSync(output,{recursive:true});await db.connect();await sampler.connect();
  try{
    await db.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    await db.query("INSERT INTO users(user_id,email,full_name,password_hash,updated_at) VALUES($1,$2,'Followup benchmark','unused',now())",[user,`followup-${user}@example.test`]);
    for(let i=0;i<ids.length;i++)await db.query("INSERT INTO bank_accounts(id,user_id,account_number,account_name,account_type,current_balance,updated_at) VALUES($1,$2,$3,'Followup','PAYMENT',$4::numeric,now())",[ids[i],user,numbers[i],initial.toString()]);
    const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (!selectedProfiles) assert.equal(hash(path.join(baseline,'modules/money-movement/infrastructure/persistence/prisma-unit-of-work.js')),
      hash(path.join(root,'dist/modules/money-movement/infrastructure/persistence/prisma-unit-of-work.js')),
      'Run prepare-followup-baseline after the latest build; UoW must be byte-identical');
    fs.writeFileSync(path.join(output,'environment.json'),JSON.stringify({runId,timestamp:new Date().toISOString(),platform:os.platform(),release:os.release(),cpu:os.cpus()[0].model,
      logicalCpus:os.cpus().length,ramBytes:os.totalmem(),node:process.version,postgres:(await db.query('SELECT version()')).rows[0].version,
      rounds,duration,baselineCommit:'8ad478154e3772eb60e08cc8a741b087843dd35f',
      improvedCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
      baselineTransferJsSha256:selectedProfiles ? undefined : hash(path.join(baseline,'modules/money-movement/application/use-cases/transfer-money.use-case.js')),
      improvedTransferJsSha256:hash(path.join(root,'dist/modules/money-movement/application/use-cases/transfer-money.use-case.js')),
      uowIdentical:selectedProfiles || hash(path.join(baseline,'modules/money-movement/infrastructure/persistence/prisma-unit-of-work.js'))===hash(path.join(root,'dist/modules/money-movement/infrastructure/persistence/prisma-unit-of-work.js')) ? true : false,
      profiles: selectedProfiles?.map(name=>({name,...profiles[name]})),
      lockfileSha256:hash(path.join(root,'package-lock.json')),
      queue:{activeLimit:process.env.TRANSFER_ACTIVE_LIMIT??'8',limit:process.env.TRANSFER_QUEUE_LIMIT??'128',waitMs:process.env.TRANSFER_QUEUE_WAIT_MS??'3000'},
      protocol: (selectedProfiles ? 'Same compiled app/schema and frozen lockfile for all profiles; environment switches enable one or more candidates. ' : 'Same schema, telemetry, UoW and runtime; only the compiled transfer use case differs. ') +
        'Closed-loop HTTP, zero think time, 2-second warmup. Alternating version order. SQL deltas exclude warmup/reset/reconciliation. 50ms lock sampling is approximate. All services share the host.',
      sourceDiff:execFileSync('git',['diff','--stat'],{cwd:root,encoding:'utf8'})},null,2));
    const scenarios=[...[1,10,50,...(selectedProfiles?[100]:[])].map(clients=>({name:`transfer_hot_${clients}`,clients})),{name:'transfer_distributed_10',clients:10,distributed:true}];
    const variants=selectedProfiles??['baseline','improved'];
    for(let round=1;round<=rounds;round++)for(const variant of round%2?variants:[...variants].reverse()){
      await start(!selectedProfiles&&variant==='baseline'?baseline:path.join(root,'dist'),
        selectedProfiles ? profiles[variant] : profiles.baseline);
      for(const scenario of scenarios){
        if(process.env.SCENARIOS&&!process.env.SCENARIOS.split(',').includes(scenario.name))continue;
        await reset();await load(scenario,2);await reset();await ipc('reset');
        const before=await sqlStats();const {metrics,samples}=await measured(scenario);const after=await sqlStats();
        const telemetry=(await ipc('snapshot')).snapshot;
        const row={round,variant,scenario:scenario.name,clients:scenario.clients,...metrics,telemetry,
          lockSampling:{intervalMs:50,samples:samples.length,maxWaiting:Math.max(0,...samples.map(s=>s.waitingOnLock)),
            meanWaiting:samples.reduce((n,s)=>n+s.waitingOnLock,0)/samples.length,blockedSampleFraction:samples.filter(s=>s.waitingOnLock>0).length/samples.length},
          sql:sqlDiff(before,after)};
        let reconciliationError;
        try{row.reconciliation=await reconcile(metrics.successes);}
        catch(error){row.reconciliation={conserved:false,ledgerMatchesBalances:false,error:error.message};reconciliationError=error;}
        rows.push(row);fs.writeFileSync(path.join(output,'runs.json'),JSON.stringify(rows,null,2));
        if(Object.keys(metrics.errors).length)fs.writeFileSync(path.join(output,`failure-${round}-${variant}-${scenario.name}.log`),log);
        console.log(JSON.stringify({round,variant,scenario:scenario.name,rps:row.successRps,p95:row.p95,errors:row.errors,meanWaiting:row.lockSampling.meanWaiting}));
        if(reconciliationError)throw reconciliationError;
      }await stop();
    }
  }finally{
    await stop();await db.query('DELETE FROM financial_transactions WHERE account_id=ANY($1::text[])',[ids]);
    await db.query('DELETE FROM transfers WHERE initiated_by_user_id=$1',[user]);await db.query('DELETE FROM bank_accounts WHERE user_id=$1',[user]);
    await db.query('DELETE FROM users WHERE user_id=$1',[user]);await sampler.end();await db.end();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
