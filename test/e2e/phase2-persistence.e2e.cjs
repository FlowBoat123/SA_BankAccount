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
const { DepositMoneyUseCase } = require('../../dist/modules/money-movement/application/use-cases/deposit-money.use-case');
const { MoneyMovementTelemetry } = require('../../dist/common/observability/money-movement-telemetry');
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

test('compact posting preserves VND precision, replay shape and both ledger entries', async () => {
  const compact = new TransferMoneyUseCase(new PrismaUnitOfWork(prisma, undefined, { get: () => 'on' }));
  const amount = '9007199254740993';
  await db.query('UPDATE bank_accounts SET current_balance=$2::numeric WHERE id=$1', [ids[0], amount]);
  const cmd = command({ amount: `0${amount}`, description: 'compact posting' });
  const pairs = await Promise.all([compact.execute(cmd), compact.execute(cmd)]);
  assert.equal(pairs.filter(result => !result.isReplay).length, 1);
  assert.deepEqual(pairs[0].transfer, pairs[1].transfer);
  assert.equal(pairs[0].transfer.amount, amount);
  const entries = await prisma.financialTransaction.findMany({ where: { transferId: pairs[0].transfer.id } });
  assert.equal(entries.length, 2);
  const debit = entries.find(entry => entry.transactionType === 'DEBIT');
  const credit = entries.find(entry => entry.transactionType === 'CREDIT');
  assert.equal(debit.referenceType, 'TRANSFER_OUT');
  assert.equal(debit.balanceAfter.toString(), '0');
  assert.equal(credit.referenceType, 'TRANSFER_IN');
  assert.equal(credit.balanceAfter.toString(), (BigInt(amount) + 100n).toString());
  assert.ok(entries.every(entry => entry.amount.toString() === amount && entry.description === cmd.description));
});

test('compact posting rolls back account updates on a database constraint failure', async () => {
  const compact = new PrismaUnitOfWork(prisma, undefined, { get: () => 'on' });
  const old = await balances();
  await assert.rejects(compact.execute(async ctx => {
    await ctx.accounts.lockManyForUpdate(ids.slice(0, 2));
    await ctx.transfers.post({
      sourceAccountId: ids[0], destinationAccountId: ids[1], initiatedByUserId: stranger,
      amount: '10', idempotencyKey: randomUUID(), sourceBalance: '90', destinationBalance: '110',
    });
  }), error => error.code === 'P2010' && error.meta?.code === '23503');
  assert.deepEqual(await balances(), old);
  assert.equal(await prisma.transfer.count({ where: { sourceAccountId: ids[0] } }), 0);
  assert.equal(await prisma.financialTransaction.count({ where: { accountId: { in: ids } } }), 0);
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

for (const [name, UseCase, expected] of [['deposit', DepositMoneyUseCase, '110'], ['withdrawal', WithdrawMoneyUseCase, '90']]) {
  test(`20 simultaneous ${name} requests with one key commit exactly once`, async () => {
    const cash = new UseCase(uow), cmd = { accountId: ids[0], userId, amount: '10', idempotencyKey: randomUUID() };
    const results = await Promise.all(Array.from({length:20}, () => cash.executeWithResult(cmd)));
    assert.equal(results.filter(r=>!r.isReplay).length, 1);
    assert.equal(new Set(results.map(r=>r.transaction.id)).size, 1);
    assert.equal((await prisma.bankAccount.findUnique({where:{id:ids[0]}})).currentBalance.toString(), expected);
    assert.equal(await prisma.financialTransaction.count({where:{accountId:ids[0]}}), 1);
    assert.ok(results.every(r=>!Object.hasOwn(r.transaction,'idempotencyKey')));
  });
}

test('cash same key with changed amount, description or type conflicts; concurrent conflict also commits once', async () => {
  const deposit = new DepositMoneyUseCase(uow), withdraw = new WithdrawMoneyUseCase(uow);
  const cmd = {accountId:ids[0],userId,amount:'10',idempotencyKey:randomUUID()};
  await deposit.execute(cmd);
  for (const change of [{amount:'11'},{description:'changed'}])
    await assert.rejects(deposit.execute({...cmd,...change}),e=>e.errorCode==='IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(withdraw.execute(cmd),e=>e.errorCode==='IDEMPOTENCY_KEY_REUSED');
  const second = {...cmd,idempotencyKey:randomUUID()};
  const results=await Promise.allSettled([deposit.execute(second),deposit.execute({...second,amount:'11'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.errorCode,'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await prisma.financialTransaction.count({where:{accountId:ids[0]}}),2);
});

test('cash keys are account-scoped and ownership is checked before replay', async () => {
  const deposit=new DepositMoneyUseCase(uow), cmd={accountId:ids[0],userId,amount:'10',idempotencyKey:randomUUID()};
  const first=await deposit.execute(cmd), other=await deposit.execute({...cmd,accountId:ids[1]});
  assert.notEqual(first.id,other.id);
  await assert.rejects(deposit.execute({...cmd,userId:stranger}),e=>e.errorCode==='ACCOUNT_NOT_FOUND');
  assert.equal(await prisma.financialTransaction.count({where:{accountId:{in:ids}}}),2);
});

test('cash replay after later writes and close returns original snapshot, not current balance', async () => {
  const withdraw=new WithdrawMoneyUseCase(uow), cmd={accountId:ids[0],userId,amount:'10',idempotencyKey:randomUUID()};
  const first=await withdraw.execute(cmd);
  await withdraw.execute({...cmd,amount:'90',idempotencyKey:randomUUID()});
  await db.query("UPDATE bank_accounts SET status='CLOSED',closed_at=now() WHERE id=$1",[ids[0]]);
  assert.deepEqual(await withdraw.execute(cmd),first);
  await assert.rejects(withdraw.execute({...cmd,idempotencyKey:randomUUID()}),e=>e.errorCode==='ACCOUNT_NOT_ACTIVE');
  assert.equal(await prisma.financialTransaction.count({where:{accountId:ids[0]}}),2);
});

test('rollback after cash ledger insert leaves no balance change or reserved key', async () => {
  const cmd={accountId:ids[0],userId,amount:'10',idempotencyKey:randomUUID()};
  const broken={execute:work=>uow.execute(ctx=>work({...ctx,transactions:{...ctx.transactions,create:async input=>{
    await ctx.transactions.create(input);throw Error('cash failure after ledger');
  }}}))};
  await assert.rejects(new DepositMoneyUseCase(broken).execute(cmd),/cash failure after ledger/);
  assert.equal((await prisma.bankAccount.findUnique({where:{id:ids[0]}})).currentBalance.toString(),'100');
  assert.equal(await prisma.financialTransaction.count({where:{accountId:ids[0]}}),0);
  assert.equal((await new DepositMoneyUseCase(uow).executeWithResult(cmd)).isReplay,false);
});

test('insufficient-funds failure does not reserve a cash key; legacy calls remain separate', async () => {
  const withdraw=new WithdrawMoneyUseCase(uow), deposit=new DepositMoneyUseCase(uow);
  const cmd={accountId:ids[0],userId,amount:'110',idempotencyKey:randomUUID()};
  await assert.rejects(withdraw.execute(cmd),e=>e.errorCode==='INSUFFICIENT_FUNDS');
  await deposit.execute({accountId:ids[0],userId,amount:'10'});
  await deposit.execute({accountId:ids[0],userId,amount:'10'});
  assert.equal((await withdraw.executeWithResult(cmd)).isReplay,false);
  assert.equal((await prisma.bankAccount.findUnique({where:{id:ids[0]}})).currentBalance.toString(),'10');
  assert.equal(await prisma.financialTransaction.count({where:{accountId:ids[0]}}),3);
});

test('database unique constraint protects cash keys even if application locking is bypassed', async () => {
  const cmd={accountId:ids[0],userId,amount:'10',idempotencyKey:randomUUID()};
  await new DepositMoneyUseCase(uow).execute(cmd);
  await assert.rejects(prisma.financialTransaction.create({data:{accountId:ids[0],transactionType:'CREDIT',
    referenceType:'CASH_DEPOSIT',amount:'10',balanceAfter:'120',idempotencyKey:cmd.idempotencyKey}}),e=>e.code==='P2002');
});

test('cash key normalization, boundary validation and no-op rejection', async () => {
  const deposit=new DepositMoneyUseCase(uow),key=randomUUID(),cmd={accountId:ids[0],userId,amount:'10',idempotencyKey:key};
  const first=await deposit.execute(cmd);
  assert.equal((await deposit.execute({...cmd,idempotencyKey:`  ${key}  `})).id,first.id);
  for(const idempotencyKey of ['', 'x'.repeat(15), 'x'.repeat(129)])
    await assert.rejects(deposit.execute({...cmd,idempotencyKey}),e=>e.errorCode==='VALIDATION_ERROR');
  for(const idempotencyKey of ['a'.repeat(16),'z'.repeat(128)])
    await deposit.execute({...cmd,idempotencyKey});
  assert.equal(await prisma.financialTransaction.count({where:{accountId:ids[0]}}),3);
});

test('cash timeout AFTER ledger insertion rolls back key and balance before bounded retry', async () => {
  let attempts=0;
  const delayed={execute:work=>uow.execute(ctx=>{
    attempts++;return work({...ctx,transactions:{...ctx.transactions,create:async input=>{
      const result=await ctx.transactions.create(input);
      if(attempts===1)await new Promise(ok=>setTimeout(ok,5150));
      return result;
    }}});
  })};
  const cmd={accountId:ids[0],userId,amount:'10',idempotencyKey:randomUUID()};
  const posted=await new DepositMoneyUseCase(delayed).execute(cmd);
  assert.equal(attempts,2);
  assert.equal((await prisma.bankAccount.findUnique({where:{id:ids[0]}})).currentBalance.toString(),'110');
  assert.equal(await prisma.financialTransaction.count({where:{accountId:ids[0]}}),1);
  assert.equal((await new DepositMoneyUseCase(uow).execute(cmd)).id,posted.id);
});

test('three-account cyclic transfers with concurrent cash writes conserve money without deadlock', async () => {
  const deposit=new DepositMoneyUseCase(uow),withdraw=new WithdrawMoneyUseCase(uow);
  await Promise.all([
    ...Array.from({length:60},(_,i)=>transfer.execute(command({sourceAccountId:ids[i%3],destinationAccountNumber:numbers[(i+1)%3],amount:'1'}))),
    ...Array.from({length:10},()=>deposit.execute({accountId:ids[0],userId,amount:'1',idempotencyKey:randomUUID()})),
    ...Array.from({length:10},()=>withdraw.execute({accountId:ids[0],userId,amount:'1',idempotencyKey:randomUUID()})),
  ]);
  assert.ok((await balances()).every(r=>r.balance==='100'));
  assert.equal(await prisma.financialTransaction.count({where:{accountId:{in:ids}}}),140);
});

test('telemetry observes a real blocked lock and one transfer uses one locking query', async () => {
  const holder=new Client({connectionString:url});await holder.connect();
  const telemetry=new MoneyMovementTelemetry(), measured=new TransferMoneyUseCase(new PrismaUnitOfWork(prisma,telemetry));
  let pending;
  try {
    await holder.query('BEGIN');await holder.query('SELECT id FROM bank_accounts WHERE id=$1 FOR UPDATE',[ids[0]]);
    const pid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending=measured.execute(command());
    const deadline=Date.now()+3000;let blocked=false;
    while(Date.now()<deadline){
      blocked=(await db.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].n>0;
      if(blocked)break;await new Promise(ok=>setTimeout(ok,10));
    }
    assert.equal(blocked,true);await new Promise(ok=>setTimeout(ok,60));
    await holder.query('COMMIT');await pending;
    const snapshot=telemetry.snapshot();
    assert.equal(snapshot.counters.committed,1);assert.equal(snapshot.counters.attempts,1);
    assert.equal(snapshot.timings.account_lock_query.count,1);assert.ok(snapshot.timings.account_lock_query.maxMs>=60);
    assert.ok(!JSON.stringify(snapshot).includes(ids[0]));
  } finally { await holder.query('ROLLBACK');await holder.end();if(pending)await pending; }
});
