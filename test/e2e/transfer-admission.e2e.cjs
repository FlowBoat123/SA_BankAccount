require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { TransferAdmission } = require('../../dist/modules/money-movement/infrastructure/transfer-admission');
const { MoneyMovementTelemetry } = require('../../dist/common/observability/money-movement-telemetry');

function setup(mode, active = 2, limit = 2, waitMs = 1000) {
  const settings = {
    TRANSFER_ADMISSION: mode,
    TRANSFER_ACTIVE_LIMIT: active,
    TRANSFER_QUEUE_LIMIT: limit,
    TRANSFER_QUEUE_WAIT_MS: waitMs,
  };
  const telemetry = new MoneyMovementTelemetry();
  return { gate: new TransferAdmission({ getOrThrow: key => settings[key] }, telemetry), telemetry };
}

test('account mode preserves order on shared source or recipient and admits independent work', async () => {
  const { gate } = setup('account');
  const hold = Promise.withResolvers();
  const order = [];
  const first = gate.run('A', 'X', () => hold.promise);
  const second = gate.run('B', 'X', async () => { order.push('second'); });
  const third = gate.run('B', 'Y', async () => { order.push('third'); });
  await gate.run('C', 'Z', async () => { order.push('independent'); });
  assert.deepEqual(order, ['independent']);
  hold.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ['independent', 'second', 'third']);
});

test('global mode caps active work and rejects full or expired queue without invoking callbacks', async () => {
  const { gate, telemetry } = setup('global', 1, 1, 20);
  const hold = Promise.withResolvers();
  const first = gate.run('A', 'X', () => hold.promise);
  const mustNotRun = async () => assert.fail('rejected work entered database callback');
  const overloaded = error => error.httpStatus === 503 && error.errorCode === 'TRANSFER_OVERLOADED';
  const expired = assert.rejects(gate.run('B', 'Y', mustNotRun), overloaded);
  await assert.rejects(gate.run('C', 'Z', mustNotRun), overloaded);
  await expired;
  hold.resolve();
  await first;
  assert.equal(await gate.run('C', 'Z', async () => 123), 123);
  assert.equal(telemetry.snapshot().counters.queue_timeout, 1);
  assert.equal(telemetry.snapshot().counters.queue_full, 1);
});

test('disconnect removes a queued request and a failed active request releases its slot', async () => {
  const { gate, telemetry } = setup('account', 1, 1);
  const hold = Promise.withResolvers();
  const attempted = assert.rejects(gate.run('A', 'X', () => hold.promise), /failed/);
  const client = new AbortController();
  const cancelled = assert.rejects(gate.run('A', 'X', async () => assert.fail('cancelled work started'), client.signal));
  client.abort();
  await cancelled;
  const next = gate.run('A', 'X', async () => 'done');
  hold.reject(new Error('failed'));
  await attempted;
  assert.equal(await next, 'done');
  assert.equal(telemetry.snapshot().counters.queue_cancelled, 1);
});
