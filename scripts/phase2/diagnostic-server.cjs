// Operator/benchmark process only. No public metrics route or payload logging.
require('reflect-metadata');
const path = require('node:path');
const dist = path.resolve(process.argv[2] || 'dist');
const { createApplication } = require(path.join(dist, 'bootstrap.js'));
const { MoneyMovementTelemetry } = require(path.join(dist, 'common/observability/money-movement-telemetry.js'));

async function main() {
  const app = await createApplication();
  const telemetry = app.get(MoneyMovementTelemetry);
  await app.listen(Number(process.env.PORT || 3318), '127.0.0.1');
  process.on('message', async message => {
    if (message?.command === 'snapshot') process.send?.({ id: message.id, snapshot: telemetry.snapshot() });
    if (message?.command === 'reset') {
      telemetry.reset(); process.send?.({ id: message.id, reset: true });
    }
    if (message?.command === 'close') {
      await app.close(); process.disconnect();
    }
  });
  process.send?.({ ready: true });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
