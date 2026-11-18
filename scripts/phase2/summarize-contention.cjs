const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const directory = process.argv[2];
const chosen = process.argv[3];
if (!directory) throw Error('Usage: node scripts/phase2/summarize-contention.cjs <results directory> [chosen profile]');

const runs = JSON.parse(fs.readFileSync(path.join(directory, 'runs.json'), 'utf8'));
const environment = JSON.parse(fs.readFileSync(path.join(directory, 'environment.json'), 'utf8'));
const keys = runs.map(run => [run.round, run.variant, run.scenario].join(':'));
assert.equal(new Set(keys).size, runs.length, 'Duplicate run');
const scenarios = [...new Set(runs.map(run => run.scenario))];
const profiles = environment.profiles.map(profile => profile.name);
assert.equal(runs.length, scenarios.length * profiles.length * environment.rounds, 'Missing runs');

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const groups = [];
for (const scenario of scenarios) {
  for (const profile of profiles) {
    const group = runs.filter(run => run.scenario === scenario && run.variant === profile);
    const mid = key => median(group.map(run => run[key]));
    const sum = key => group.reduce((total, run) => total + run[key], 0);
    const timing = name => median(group.map(run => {
      const metric = run.telemetry.timings[name];
      // Amortize each stage across all transaction attempts, including statements
      // occurring more than once within a transaction.
      return (metric?.sumMs || 0) / (run.telemetry.counters.attempts || 1);
    }));
    const counters = name => group.reduce((total, run) => total + (run.telemetry.counters[name] || 0), 0);
    groups.push({
      scenario, profile, runs: group.length,
      p50: mid('p50'), p95: mid('p95'), p99: mid('p99'),
      p95Min: Math.min(...group.map(run => run.p95)), p95Max: Math.max(...group.map(run => run.p95)),
      successP95: mid('successP95'), successP99: mid('successP99'), rps: mid('successRps'),
      requests: sum('requests'), successes: sum('successes'), errors: sum('requests') - sum('successes'),
      reconciled: group.filter(run => run.reconciliation?.ledgerMatchesBalances && run.reconciliation?.conserved).length,
      retries: counters('retries'), queueFull: counters('queue_full'), queueTimeout: counters('queue_timeout'),
      queueCancelled: counters('queue_cancelled'),
      meanWaitingLocks: median(group.map(run => run.lockSampling.meanWaiting)),
      startMsPerAttempt: timing('transaction_start'), lockMsPerAttempt: timing('account_lock_query'),
      writeMsPerAttempt: timing('transfer_write'), queueMsPerAttempt: timing('transfer_queue_wait'),
    });
  }
}
fs.writeFileSync(path.join(directory, 'profiles-summary.json'), JSON.stringify(groups, null, 2) + '\n');
if (chosen) {
  assert.ok(profiles.includes(chosen) && profiles.includes('baseline'));
  const chart = scenarios.map(scenario => ({
    scenario,
    baseline: groups.find(group => group.scenario === scenario && group.profile === 'baseline'),
    improved: groups.find(group => group.scenario === scenario && group.profile === chosen),
  }));
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(chart, null, 2) + '\n');
}
console.table(groups.map(({ scenario, profile, p95, successP95, rps, errors, reconciled }) => ({
  scenario, profile, p95: p95?.toFixed(1), successP95: successP95?.toFixed(1), rps: rps?.toFixed(1), errors, reconciled,
})));
