const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const {Client}=require('pg');
const url=process.env.DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_test'))throw Error('Dedicated *_test database required');
const base=process.env.SMOKE_BASE_URL||'http://127.0.0.1:3318/api/v1';
const db=new Client({connectionString:url});let userId;
async function request(route,{body,token,key,status=200}={}){
 const response=await fetch(base+route,{method:body?'POST':'GET',signal:AbortSignal.timeout(15000),
  headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...(key?{'Idempotency-Key':key}:{})},
  ...(body?{body:JSON.stringify(body)}:{})});
 const json=await response.json();assert.equal(response.status,status,JSON.stringify(json));return json;
}
async function main(){
 await db.connect();
 try{
  await request('/accounts',{status:401});
  const email=`docker-${randomUUID()}@example.test`,password='Phase2Docker123!';
  userId=(await request('/auth/register',{body:{email,password,confirmPassword:password,fullName:'Docker smoke'},status:201})).data.id;
  const token=(await request('/auth/login',{body:{email,password}})).data.accessToken;
  const open=balance=>request('/accounts',{token,status:201,body:{accountName:'Docker smoke',accountType:'PAYMENT',initialDeposit:balance}});
  const a=(await open('100000')).data,b=(await open('0')).data;
  const body={sourceAccountId:a.id,destinationAccountNumber:b.accountNumber,amount:'10000'},key=randomUUID();
  const first=await request('/transfers',{token,body,key,status:201});
  const replay=await request('/transfers',{token,body,key});assert.deepEqual(replay.data,first.data);
  const conflict=await request('/transfers',{token,body:{...body,amount:'10001'},key,status:409});
  assert.equal(conflict.error.code,'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await request(`/accounts/${a.id}`,{token})).data.currentBalance,'90000');
  assert.equal((await request(`/accounts/${b.id}`,{token})).data.currentBalance,'10000');
  const endpoint=`/accounts/${a.id}/transactions`;
  const page1=(await request(endpoint+'/feed?limit=1',{token})).data;
  assert.equal(page1.hasMore,true);
  const page2=(await request(endpoint+`/feed?limit=1&cursor=${page1.nextCursor}`,{token})).data;
  assert.equal(page2.hasMore,false);
  const legacy=await request(endpoint,{token});assert.equal(legacy.pagination.total,2);
  assert.deepEqual([...page1.items,...page2.items].map(r=>r.id),legacy.data.map(r=>r.id));
  const evidence={passed:true,healthStatus:execFileSync('docker',['inspect','--format','{{.State.Health.Status}}','sa-bank-phase2-api'],{encoding:'utf8'}).trim(),
   imageId:execFileSync('docker',['image','inspect','--format','{{.Id}}','sa-bank-phase2:local'],{encoding:'utf8'}).trim(),
   containerNode:execFileSync('docker',['exec','sa-bank-phase2-api','node','--version'],{encoding:'utf8'}).trim(),
   checks:['register/login','atomic transfer','identical replay','changed payload 409','balances','cursor pages','legacy pagination'],timestamp:new Date().toISOString()};
  assert.equal(evidence.healthStatus,'healthy');
  fs.writeFileSync('docs/performance/phase2/results/docker-smoke.json',JSON.stringify(evidence,null,2));console.log(evidence);
 }finally{
  if(userId){
   const ids=(await db.query('SELECT id FROM bank_accounts WHERE user_id=$1',[userId])).rows.map(r=>r.id);
   await db.query('DELETE FROM financial_transactions WHERE account_id=ANY($1::text[])',[ids]);
   await db.query('DELETE FROM transfers WHERE initiated_by_user_id=$1',[userId]);
   await db.query('DELETE FROM bank_accounts WHERE user_id=$1',[userId]);
   await db.query('DELETE FROM users WHERE user_id=$1',[userId]);
  }
  await db.end();
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
