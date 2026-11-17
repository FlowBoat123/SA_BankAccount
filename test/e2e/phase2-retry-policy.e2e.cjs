require('reflect-metadata');
const { test }=require('node:test');
const assert=require('node:assert/strict');
const { Prisma }=require('@prisma/client');
const { PrismaUnitOfWork }=require('../../dist/modules/money-movement/infrastructure/persistence/prisma-unit-of-work');
const failure=(code,error)=>new Prisma.PrismaClientKnownRequestError(error,{code,clientVersion:'7.10.0',meta:{error}});
test('bounded retry retries an aborted transaction once',async()=>{
  let attempts=0;
  const prisma={$transaction:async()=>{if(++attempts===1)throw failure('P2034','Transaction aborted');return 'ok';}};
  assert.equal(await new PrismaUnitOfWork(prisma).execute(()=>{}),'ok');assert.equal(attempts,2);
});
test('retry exhaustion returns explicit 503 after exactly two attempts',async()=>{
  let attempts=0;
  const prisma={$transaction:async()=>{attempts++;throw failure('P2034','Transaction aborted');}};
  await assert.rejects(new PrismaUnitOfWork(prisma).execute(()=>{}),e=>e.errorCode==='TRANSACTION_BUSY'&&e.httpStatus===503);
  assert.equal(attempts,2);
});
test('never retries constraints, ambiguous commit, transport, or domain errors',async()=>{
  for(const error of [failure('P2002','Unique constraint'),failure('P2028','Transaction already committed'),Error('connection lost'),{errorCode:'INSUFFICIENT_FUNDS'}]){
    let attempts=0;const prisma={$transaction:async()=>{attempts++;throw error;}};
    await assert.rejects(new PrismaUnitOfWork(prisma).execute(()=>{}),e=>e===error);assert.equal(attempts,1);
  }
});
