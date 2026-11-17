require('reflect-metadata');
const { before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaUnitOfWork } = require('../../dist/modules/money-movement/infrastructure/persistence/prisma-unit-of-work');
const { TransferMoneyUseCase } = require('../../dist/modules/money-movement/application/use-cases/transfer-money.use-case');
const { WithdrawMoneyUseCase } = require('../../dist/modules/money-movement/application/use-cases/withdraw-money.use-case');
const { PrismaTransactionQuery } = require('../../dist/modules/money-movement/infrastructure/persistence/prisma-transaction-query');
const { GetTransactionFeedUseCase } = require('../../dist/modules/money-movement/application/use-cases/get-transaction-feed.use-case');
const url = process.env.DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('Dedicated *_test database required');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
const db = new Client({ connectionString: url });
const userId = randomUUID(), stranger = randomUUID();
const ids = Array.from({length:3},()=>randomUUID()), numbers = ids.map((_,i)=>`T${userId.slice(0,8)}${i}`);
let uow, transfer, feed;
const command = (overrides={})=>({sourceAccountId:ids[0],destinationAccountNumber:numbers[1],initiatedByUserId:userId,amount:'10',idempotencyKey:randomUUID(),...overrides});
const balances = async()=> (await db.query('SELECT id,current_balance::text balance FROM bank_accounts WHERE id=ANY($1::text[]) ORDER BY id',[ids])).rows;
before(async()=>{
  await db.connect(); await prisma.$connect();
  await db.query("INSERT INTO users(user_id,email,full_name,password_hash,updated_at) VALUES($1,$2,'P2','unused',now())",[userId,`test-${userId}@example.test`]);
  for(let i=0;i<ids.length;i++)await db.query("INSERT INTO bank_accounts(id,user_id,account_number,account_name,account_type,current_balance,updated_at) VALUES($1,$2,$3,'P2','PAYMENT',100,now())",[ids[i],userId,numbers[i]]);
  uow = new PrismaUnitOfWork(prisma); transfer = new TransferMoneyUseCase(uow);
  feed = new GetTransactionFeedUseCase(new PrismaTransactionQuery(prisma));
});
beforeEach(async()=>{
  await db.query('DELETE FROM financial_transactions WHERE account_id=ANY($1::text[])',[ids]);
  await db.query('DELETE FROM transfers WHERE initiated_by_user_id=$1',[userId]);
  await db.query("UPDATE bank_accounts SET current_balance=100,status='ACTIVE',closed_at=NULL WHERE id=ANY($1::text[])",[ids]);
});
after(async()=>{
  await db.query('DELETE FROM financial_transactions WHERE account_id=ANY($1::text[])',[ids]);
  await db.query('DELETE FROM transfers WHERE initiated_by_user_id=$1',[userId]);
  await db.query('DELETE FROM bank_accounts WHERE user_id=$1',[userId]);
  await db.query('DELETE FROM users WHERE user_id=$1',[userId]);
  await prisma.$disconnect(); await db.end();
});
test('20 simultaneous retries: one transfer, two ledger entries, same response ID',async()=>{
  const cmd=command();const results=await Promise.all(Array.from({length:20},()=>transfer.execute(cmd)));
  assert.equal(results.filter(r=>!r.isReplay).length,1);assert.equal(new Set(results.map(r=>r.transfer.id)).size,1);
  assert.equal((await prisma.financialTransaction.count({where:{accountId:{in:ids}}})),2);
  assert.equal((await prisma.bankAccount.findUnique({where:{id:ids[0]}})).currentBalance.toString(),'90');
});
test('same key with changed amount, destination, or description returns conflict without writes',async()=>{
  const cmd=command();await transfer.execute(cmd);const old=await balances();
  for(const change of [{amount:'11'},{destinationAccountNumber:numbers[2]},{description:'different'}]){
    await assert.rejects(transfer.execute({...cmd,...change}),e=>e.errorCode==='IDEMPOTENCY_KEY_REUSED');
  }
  assert.deepEqual(await balances(),old);assert.equal(await prisma.transfer.count({where:{initiatedByUserId:userId}}),1);
});
test('concurrent same-key different payload: one creation and one conflict',async()=>{
  const cmd=command();const results=await Promise.allSettled([transfer.execute(cmd),transfer.execute({...cmd,amount:'11'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.errorCode,'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await prisma.financialTransaction.count({where:{accountId:{in:ids}}}),2);
});
test('40 crossed transfers complete and conserve balances',async()=>{
  await Promise.all(Array.from({length:40},(_,i)=>transfer.execute(command(i%2?{sourceAccountId:ids[1],destinationAccountNumber:numbers[0],amount:'1'}:{amount:'1'}))));
  assert.ok((await balances()).every(r=>r.balance==='100'));
  assert.equal(await prisma.financialTransaction.count({where:{accountId:{in:ids}}}),80);
});
test('20 concurrent withdrawals of 10 from 100: exactly ten accepted',async()=>{
  const withdraw=new WithdrawMoneyUseCase(uow);
  const result=await Promise.allSettled(Array.from({length:20},()=>withdraw.execute({accountId:ids[0],userId,amount:'10'})));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,10);
  assert.ok(result.filter(r=>r.status==='rejected').every(r=>r.reason.errorCode==='INSUFFICIENT_FUNDS'));
  assert.equal((await prisma.bankAccount.findUnique({where:{id:ids[0]}})).currentBalance.toString(),'0');
});
test('failure AFTER both balances and ledger insert rolls the entire transaction back',async()=>{
  const old=await balances();
  const broken = {execute:work=>uow.execute(ctx=>work({...ctx,transactions:{...ctx.transactions,createMany:async entries=>{
    await ctx.transactions.createMany(entries); throw Error('injected after ledger insert');
  }}}))};
  await assert.rejects(new TransferMoneyUseCase(broken).execute(command()),/injected after ledger insert/);
  assert.deepEqual(await balances(),old);
  assert.equal(await prisma.transfer.count({where:{initiatedByUserId:userId}}),0);
  assert.equal(await prisma.financialTransaction.count({where:{accountId:{in:ids}}}),0);
});
test('batch ledger constraint failure rolls back balances and transfer',async()=>{
  const old=await balances();
  const broken={execute:work=>uow.execute(ctx=>work({...ctx,transactions:{...ctx.transactions,createMany:entries=>ctx.transactions.createMany([entries[0],entries[0]])}}))};
  await assert.rejects(new TransferMoneyUseCase(broken).execute(command()));
  assert.deepEqual(await balances(),old);assert.equal(await prisma.transfer.count({where:{initiatedByUserId:userId}}),0);
});
test('expired transaction is rolled back before one retry; balances and entries change once',async()=>{
  let attempts=0;
  const delayed={execute:work=>uow.execute(ctx=>{
    attempts++;
    return work({...ctx,transactions:{...ctx.transactions,createMany:async entries=>{
      if(attempts===1)await new Promise(ok=>setTimeout(ok,5150));
      await ctx.transactions.createMany(entries);
    }}});
  })};
  await new TransferMoneyUseCase(delayed).execute(command());
  assert.equal(attempts,2);
  assert.equal((await prisma.bankAccount.findUnique({where:{id:ids[0]}})).currentBalance.toString(),'90');
  assert.equal((await prisma.bankAccount.findUnique({where:{id:ids[1]}})).currentBalance.toString(),'110');
  assert.equal(await prisma.transfer.count({where:{initiatedByUserId:userId}}),1);
  assert.equal(await prisma.financialTransaction.count({where:{accountId:{in:ids}}}),2);
});
async function seedHistory(){
  // Two microsecond-distinct timestamps collapse to the SAME JavaScript ms;
  // another pair has equal timestamps and needs the ID tie-breaker.
  await db.query(`INSERT INTO financial_transactions(id,account_id,transaction_type,reference_type,amount,balance_after,created_at)
    SELECT gen_random_uuid()::text,$1,CASE WHEN n%2=0 THEN 'DEBIT'::"TransactionType" ELSE 'CREDIT'::"TransactionType" END,
      CASE WHEN n%2=0 THEN 'CASH_WITHDRAWAL'::"ReferenceType" ELSE 'CASH_DEPOSIT'::"ReferenceType" END,
      1,100,timestamptz '2026-01-01 00:00:00.000123+00'+(n/2)*interval '1 microsecond' FROM generate_series(1,9)n`,[ids[0]]);
}
test('cursor visits every row once: tied timestamps and microseconds, final page and empty history',async()=>{
  await seedHistory();let cursor,seen=[];
  do{const r=await feed.execute({accountId:ids[0],userId,limit:2,cursor});seen.push(...r.items.map(t=>t.id));cursor=r.nextCursor;assert.equal(r.hasMore,cursor!==null);}while(cursor);
  const expected=(await db.query('SELECT id FROM financial_transactions WHERE account_id=$1 ORDER BY created_at DESC,id DESC',[ids[0]])).rows.map(r=>r.id);
  assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,9);
  assert.deepEqual(await feed.execute({accountId:ids[1],userId,limit:2}),{items:[],hasMore:false,nextCursor:null});
});
test('cursor enforces ownership, account/filter scope and valid date interval',async()=>{
  await seedHistory();const first=await feed.execute({accountId:ids[0],userId,limit:2,type:'CREDIT'});
  const next=await feed.execute({accountId:ids[0],userId,limit:2,type:'CREDIT',cursor:first.nextCursor});assert.ok(next.items.every(t=>t.transactionType==='CREDIT'));
  await assert.rejects(feed.execute({accountId:ids[0],userId:stranger,limit:2}),e=>e.errorCode==='ACCOUNT_NOT_FOUND');
  await assert.rejects(feed.execute({accountId:ids[1],userId,limit:2,cursor:first.nextCursor}),e=>e.errorCode==='VALIDATION_ERROR');
  await assert.rejects(feed.execute({accountId:ids[0],userId,limit:2,type:'DEBIT',cursor:first.nextCursor}),e=>e.errorCode==='VALIDATION_ERROR');
  await assert.rejects(feed.execute({accountId:ids[0],userId,limit:2,from:new Date('2026-02-01'),to:new Date('2026-01-01')}),e=>e.errorCode==='VALIDATION_ERROR');
  const filtered=await feed.execute({accountId:ids[0],userId,limit:20,from:new Date('2026-02-01')});assert.equal(filtered.items.length,0);
});
test('new latest entry between pages does not shift or duplicate the next page',async()=>{
  await seedHistory();const first=await feed.execute({accountId:ids[0],userId,limit:3});
  const expected=(await db.query('SELECT id FROM financial_transactions WHERE account_id=$1 ORDER BY created_at DESC,id DESC OFFSET 3 LIMIT 3',[ids[0]])).rows.map(r=>r.id);
  await db.query("INSERT INTO financial_transactions(id,account_id,transaction_type,reference_type,amount,balance_after) VALUES($1,$2,'CREDIT','CASH_DEPOSIT',1,100)",[randomUUID(),ids[0]]);
  const next=await feed.execute({accountId:ids[0],userId,limit:3,cursor:first.nextCursor});assert.deepEqual(next.items.map(r=>r.id),expected);
});
