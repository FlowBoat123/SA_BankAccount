// Reproducible HTTP comparison. Uses dedicated *_test DB; never truncates other data.
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');

const root = path.resolve(__dirname, '../..');
const databaseUrl = process.env.PHASE2_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) throw Error('Set PHASE2_DATABASE_URL to a dedicated *_test DB');
const rounds = Number(process.env.ROUNDS || 3), seconds = Number(process.env.DURATION || 10);
const historySize = Number(process.env.HISTORY_SIZE || 300000);
const baseline = path.resolve(root, process.env.BASELINE_DIST || '.phase2/baseline-dist');
const output = path.resolve(root, process.env.OUTPUT || 'docs/performance/phase2/results');
const secret = 'phase2-benchmark-only-secret';
const db = new Client({ connectionString: databaseUrl });
const runId = randomUUID(), user = randomUUID(), other = randomUUID();
const accounts = Array.from({ length: 20 }, () => randomUUID());
const numbers = accounts.map((_, i) => `P2${runId.slice(0, 8)}${String(i).padStart(3, '0')}`);
const token = jwt.sign({ sub: user, email: `p2-${runId}@example.test` }, secret, { expiresIn: '2h' });
const histories = [], results = [];
let child, logs, errorLogs;

async function start(dist, port) {
  logs = ''; errorLogs = '';
  child = spawn(process.execPath, [path.join(dist, 'main.js')], {
    cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port), NODE_ENV: 'production',
      JWT_ACCESS_SECRET: secret, JWT_ACCESS_TTL: '2h', BCRYPT_ROUNDS: '12' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  child.stderr.on('data', chunk => { errorLogs = (errorLogs + chunk).slice(-100000); });
  for (let n = 0; n < 150; n++) {
    if (child.exitCode !== null) throw Error(logs);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/accounts`)).status === 401) return; } catch {}
    await new Promise(ok => setTimeout(ok, 100));
  }
  throw Error('Startup timeout: ' + logs);
}
async function stop() {
  if (child && child.exitCode === null) {
    const exit = once(child, 'exit'); child.kill(); await exit;
  }
  child = null;
}
async function seed() {
  await db.query('INSERT INTO users(user_id,email,full_name,password_hash,updated_at) VALUES($1,$2,$3,$4,now()),($5,$6,$3,$4,now())',
    [user, `p2-${runId}@example.test`, 'Phase 2 benchmark', 'not-a-login-fixture', other, `p2-other-${runId}@example.test`]);
  for (let i = 0; i < accounts.length; i++) {
    await db.query(`INSERT INTO bank_accounts(id,user_id,account_number,account_name,account_type,current_balance,updated_at)
      VALUES($1,$2,$3,'Phase 2','PAYMENT',1000000000,now())`, [accounts[i], user, numbers[i]]);
  }
  for (const size of [10000, historySize]) {
    const id = randomUUID(); histories.push({ id, size });
    await db.query(`INSERT INTO bank_accounts(id,user_id,account_number,account_name,account_type,updated_at)
      VALUES($1,$2,$3,'History benchmark','PAYMENT',now())`, [id, user, `H${size}${runId.slice(0,8)}`]);
    await db.query(`INSERT INTO financial_transactions(id,account_id,transaction_type,reference_type,amount,balance_after,created_at)
      SELECT gen_random_uuid()::text,$1,'CREDIT','CASH_DEPOSIT',1,n,
      timestamptz '2026-01-01 00:00:00+00' + n * interval '1 millisecond' FROM generate_series(1,$2::int) n`, [id, size]);
    const offset = Math.floor(size * 0.8 / 20) * 20;
    const anchor = (await db.query('SELECT id FROM financial_transactions WHERE account_id=$1 ORDER BY created_at DESC,id DESC OFFSET $2 LIMIT 1', [id, offset - 1])).rows[0].id;
    const expected = (await db.query('SELECT id FROM financial_transactions WHERE account_id=$1 ORDER BY created_at DESC,id DESC OFFSET $2 LIMIT 20', [id, offset])).rows.map(r => r.id);
    Object.assign(histories.at(-1), { offset, anchor, expected });
  }
  await db.query('ANALYZE financial_transactions');
}
async function resetWrites() {
  await db.query('DELETE FROM financial_transactions WHERE account_id=ANY($1::text[])', [accounts]);
  await db.query('DELETE FROM transfers WHERE source_account_id=ANY($1::text[])', [accounts]);
  await db.query('UPDATE bank_accounts SET current_balance=1000000000 WHERE id=ANY($1::text[])', [accounts]);
}
async function reconcile(successes) {
  const balances = (await db.query('SELECT id,current_balance::text AS balance FROM bank_accounts WHERE id=ANY($1::text[])', [accounts])).rows;
  assert.equal(balances.reduce((s, a) => s + BigInt(a.balance), 0n), 20000000000n);
  assert.ok(balances.every(a => BigInt(a.balance) >= 0n));
  const count = (await db.query('SELECT count(*)::int AS n FROM transfers WHERE source_account_id=ANY($1::text[])', [accounts])).rows[0].n;
  const entries = (await db.query('SELECT count(*)::int AS n FROM financial_transactions WHERE account_id=ANY($1::text[])', [accounts])).rows[0].n;
  assert.equal(count, successes); assert.equal(entries, successes * 2);
  const mismatch = (await db.query(`SELECT count(*)::int n FROM (
    SELECT a.id FROM bank_accounts a LEFT JOIN financial_transactions f ON f.account_id=a.id
    WHERE a.id=ANY($1::text[]) GROUP BY a.id,a.current_balance
    HAVING a.current_balance <> 1000000000 + coalesce(sum(CASE WHEN f.transaction_type='CREDIT' THEN f.amount ELSE -f.amount END),0)
  ) q`, [accounts])).rows[0].n;
  assert.equal(mismatch, 0);
  return { transfers: count, ledgerEntries: entries, conserved: true, ledgerMatchesBalances: true };
}
function resources(pid) {
  if (process.platform === 'win32') {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid}; @{cpuMs=$p.TotalProcessorTime.TotalMilliseconds;rss=$p.WorkingSet64;peakRss=$p.PeakWorkingSet64}|ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true });
    return JSON.parse(raw);
  }
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return { cpuMs: (Number(stat[11]) + Number(stat[12])) * 1000 / ticks,
      rss: Number(status.match(/VmRSS:\s+(\d+)/)[1]) * 1024, peakRss: Number(status.match(/VmHWM:\s+(\d+)/)[1]) * 1024 };
  }
  return null;
}
async function load(base, scenario, duration, measured = true) {
  const latencies = [], errors = {}, start = performance.now(), deadline = start + duration * 1000;
  let success = 0;
  await Promise.all(Array.from({ length: scenario.clients }, async (_, client) => {
    while (performance.now() < deadline) {
      const request = scenario.request(client);
      const t = performance.now();
      try {
        const res = await fetch(base + request.path, { method: request.body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...request.headers },
          ...(request.body ? { body: JSON.stringify(request.body) } : {}) });
        const body = await res.json();
        if (res.status !== (request.body ? 201 : 200) || body.success !== true) throw Error(`${res.status}:${body.error?.code}`);
        if (scenario.expected) assert.deepEqual((body.data.items || body.data).map(r => r.id), scenario.expected);
        if (request.body) {
          assert.equal(body.data.amount, '1');
          assert.equal(body.data.sourceAccountId, request.body.sourceAccountId);
          assert.equal(body.data.destinationAccountId, request.destination);
        }
        success++;
      } catch (e) { const key = e.message.slice(0, 150); errors[key] = (errors[key] || 0) + 1; }
      latencies.push(performance.now() - t);
    }
  }));
  const elapsed = (performance.now() - start) / 1000;
  latencies.sort((a,b) => a-b);
  const percentile = p => latencies[Math.min(latencies.length-1, Math.ceil(latencies.length*p)-1)];
  return { seconds: elapsed, requests: latencies.length, successes: success, errors,
    successRps: success / elapsed, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) };
}
async function plans() {
  const h = histories.at(-1), queries = {
    offset: ['SELECT * FROM financial_transactions WHERE account_id=$1 ORDER BY created_at DESC,id DESC OFFSET $2 LIMIT 20', [h.id, h.offset]],
    seek: ['SELECT * FROM financial_transactions WHERE account_id=$1 AND (created_at,id)<(SELECT created_at,id FROM financial_transactions WHERE id=$2 AND account_id=$1) ORDER BY created_at DESC,id DESC LIMIT 21', [h.id,h.anchor]],
  };
  for (const [name, [sql, args]] of Object.entries(queries)) {
    const plan = await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, args);
    fs.writeFileSync(path.join(output, `plan-${name}.json`), JSON.stringify(plan.rows, null, 2));
  }
}
async function main() {
  fs.mkdirSync(output, { recursive: true }); await db.connect();
  try {
    await seed(); await plans();
    const serverInfo = (await db.query('SELECT version()')).rows[0].version;
    fs.writeFileSync(path.join(output, 'environment.json'), JSON.stringify({ runId, timestamp: new Date().toISOString(), platform: os.platform(), release: os.release(),
      cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ramBytes: os.totalmem(), node: process.version, postgres: serverInfo,
      location: process.env.MEASUREMENT_ENVIRONMENT || 'local',
      baselineCommit: 'c347c921d77ba533cfacd8e180feccef720be013',
      improvedDiff: execFileSync('git',['diff','--stat'],{cwd:root,encoding:'utf8'}), rounds, seconds, historySizes: histories.map(h=>h.size),
      protocol: 'Closed-loop HTTP, zero think time, 2s warm-up, no login traffic; API CPU endpoints sampled outside timing; DB/generator/API share host. Feed omits exact total, legacy includes it.' }, null, 2));
    for (let round = 1; round <= rounds; round++) {
      const variants = process.env.VARIANTS ? process.env.VARIANTS.split(',') : round % 2 ? ['baseline','improved'] : ['improved','baseline'];
      for (const variant of variants) {
        const port = 3317; await start(variant === 'baseline' ? baseline : path.join(root,'dist'), port);
        const scenarios = [
          ...[1,10].map(clients => ({ name:`transfer_hot_${clients}`, clients, write:true,
            request: () => ({path:'/transfers',destination:accounts[1],headers:{'Idempotency-Key':randomUUID()},body:{sourceAccountId:accounts[0],destinationAccountNumber:numbers[1],amount:'1'}}) })),
          { name:'transfer_distributed_10',clients:10,write:true,request: i => ({path:'/transfers',destination:accounts[2*i+1],headers:{'Idempotency-Key':randomUUID()},body:{sourceAccountId:accounts[2*i],destinationAccountNumber:numbers[2*i+1],amount:'1'}}) },
          ...histories.map(h=>({name:`history_${h.size}_deep`,clients:5,expected:h.expected,
            request:()=>({path:variant==='baseline'?`/accounts/${h.id}/transactions?page=${h.offset/20+1}&limit=20`:`/accounts/${h.id}/transactions/feed?cursor=${h.anchor}&limit=20`})})),
        ];
        for (const scenario of scenarios) {
          if (process.env.SCENARIOS && !process.env.SCENARIOS.split(',').includes(scenario.name)) continue;
          if (scenario.write) await resetWrites();
          await load(`http://127.0.0.1:${port}/api/v1`,scenario,2,false);
          if (scenario.write) await resetWrites();
          const before = resources(child.pid);
          const metrics = await load(`http://127.0.0.1:${port}/api/v1`,scenario,seconds);
          const after = resources(child.pid);
          const row={round,variant,scenario:scenario.name,clients:scenario.clients,...metrics,
            apiCpuPercent: before&&after?(after.cpuMs-before.cpuMs)/(metrics.seconds*10):null,apiRssBytes:after?.rss,apiPeakRssBytes:after?.peakRss};
          if (scenario.write) row.reconciliation=await reconcile(metrics.successes);
          results.push(row); fs.writeFileSync(path.join(output,'runs.json'),JSON.stringify(results,null,2));
          if (Object.keys(row.errors).length) fs.writeFileSync(path.join(output,`failure-${round}-${variant}-${scenario.name}.log`),errorLogs+'\n'+logs);
          console.log(JSON.stringify({round,variant,scenario:scenario.name,rps:row.successRps,p95:row.p95,errors:row.errors}));
          // Keep failures in the evidence rather than discarding a bad baseline
          // or rerunning until a clean sample happens to appear.
          assert.ok(row.successes > 0, 'No successful operations in this scenario');
        }
        await stop();
      }
    }
  } finally {
    await stop();
    await db.query('DELETE FROM financial_transactions WHERE account_id IN (SELECT id FROM bank_accounts WHERE user_id=$1)',[user]);
    await db.query('DELETE FROM transfers WHERE initiated_by_user_id=$1',[user]);
    await db.query('DELETE FROM bank_accounts WHERE user_id=$1',[user]);
    await db.query('DELETE FROM users WHERE user_id=ANY($1::text[])',[[user,other]]);
    await db.end();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
