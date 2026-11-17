require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const OldTransfer = require('../../.phase2/baseline-dist/modules/money-movement/application/use-cases/transfer-money.use-case').TransferMoneyUseCase;
const OldUow = require('../../.phase2/baseline-dist/modules/money-movement/infrastructure/persistence/prisma-unit-of-work').PrismaUnitOfWork;
const NewTransfer = require('../../dist/modules/money-movement/application/use-cases/transfer-money.use-case').TransferMoneyUseCase;
const NewUow = require('../../dist/modules/money-movement/infrastructure/persistence/prisma-unit-of-work').PrismaUnitOfWork;
const url = process.env.DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('Dedicated *_test database required');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString:url }) });
const userId = randomUUID(), ids=[randomUUID(),randomUUID()];
async function main(){
  try{
    await db.user.create({data:{id:userId,email:`check-${userId}@example.test`,fullName:'Replay check',passwordHash:'unused'}});
    for(const id of ids)await db.bankAccount.create({data:{id,userId,accountNumber:id.slice(0,20),accountName:'Replay',accountType:'PAYMENT',currentBalance:'100'}});
    const cmd={sourceAccountId:ids[0],destinationAccountNumber:ids[1].slice(0,20),initiatedByUserId:userId,amount:'10',idempotencyKey:randomUUID()};
    const original=new OldTransfer(new OldUow(db)),improved=new NewTransfer(new NewUow(db));
    await original.execute(cmd);
    const changed={...cmd,amount:'11'};
    const replay=await original.execute(changed);assert.equal(replay.isReplay,true);assert.equal(replay.transfer.amount.toString(),'10');
    let conflict;
    try{await improved.execute(changed);throw Error('Expected conflict');}catch(e){assert.equal(e.errorCode,'IDEMPOTENCY_KEY_REUSED');conflict={errorCode:e.errorCode,httpStatus:e.httpStatus};}
    const evidence={baseline:{changedRequestAmount:'11',returnedAmount:replay.transfer.amount.toString(),isReplay:replay.isReplay,problem:'Changed payload silently treated as original request'},improved:conflict,
      transferCount:await db.transfer.count({where:{initiatedByUserId:userId}}),ledgerEntryCount:await db.financialTransaction.count({where:{accountId:{in:ids}}})};
    assert.equal(evidence.transferCount,1);assert.equal(evidence.ledgerEntryCount,2);
    const output=process.env.OUTPUT || 'docs/performance/phase2/results';
    fs.mkdirSync(output,{recursive:true});fs.writeFileSync(`${output}/idempotency-before-after.json`,JSON.stringify(evidence,null,2));console.log(evidence);
  }finally{
    await db.financialTransaction.deleteMany({where:{accountId:{in:ids}}});
    await db.transfer.deleteMany({where:{initiatedByUserId:userId}});
    await db.bankAccount.deleteMany({where:{userId}});await db.user.deleteMany({where:{id:userId}});await db.$disconnect();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
