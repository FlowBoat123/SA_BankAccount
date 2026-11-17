require('reflect-metadata');
const { test }=require('node:test');
const assert=require('node:assert/strict');
const { Prisma }=require('@prisma/client');
const { MoneyMovementTelemetry }=require('../../dist/common/observability/money-movement-telemetry');
const { PrismaUnitOfWork }=require('../../dist/modules/money-movement/infrastructure/persistence/prisma-unit-of-work');

test('telemetry retains bounded aggregates; snapshots and reset do not mutate prior snapshots',()=>{
  const telemetry=new MoneyMovementTelemetry();
  for(let i=0;i<10000;i++)telemetry.observe('account_lock_query',i/10);
  const first=telemetry.snapshot();
  assert.equal(first.timings.account_lock_query.count,10000);
  assert.equal(first.timings.account_lock_query.buckets.length,13);
  first.timings.account_lock_query.count=0;
  assert.equal(telemetry.snapshot().timings.account_lock_query.count,10000);
  telemetry.reset();assert.deepEqual(telemetry.snapshot().timings,{});
});

test('telemetry distinguishes committed, rejected, retried and exhausted attempts',async()=>{
  const telemetry=new MoneyMovementTelemetry();let attempt=0;
  const error=new Prisma.PrismaClientKnownRequestError('aborted',{code:'P2034',clientVersion:'7.10.0'});
  const prisma={$transaction:async work=>{if(++attempt===1)throw error;return work({});}};
  await new PrismaUnitOfWork(prisma,telemetry).execute(async()=>42);
  const snapshot=telemetry.snapshot();
  assert.deepEqual(snapshot.counters,{attempts:2,rejected:1,retries:1,committed:1});
  assert.equal(snapshot.timings.transaction_attempt.count,2);
  assert.equal(snapshot.timings.transaction_callback.count,1);
  telemetry.reset();
  await assert.rejects(new PrismaUnitOfWork({$transaction:async()=>{throw error;}},telemetry).execute(()=>{}));
  assert.equal(telemetry.snapshot().counters.retry_exhausted,1);
});
