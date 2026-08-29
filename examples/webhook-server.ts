/**
 * webhook-server - a minimal Node HTTP server that verifies webhook signatures
 * and dispatches typed events.
 *
 *   API_KEY=... npx tsx examples/webhook-server.ts
 *
 * Express alternative (mount express.raw so the body stays untouched):
 *   app.post('/webhook', express.raw({ type: '*\/*' }), (req, res) => {
 *     const evt = parseWebhookEvent(apiKey, req.body, req.header('Signature'));
 *     // ... handle evt ...
 *     res.sendStatus(200);
 *   });
 */
import { createServer } from 'node:http';
import {
  createWebhookHandler,
  WEBHOOK_SENDER_IPS,
  type WebhookEvent,
  type SweepWebhookEvent,
} from '../src/index';

const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error('set API_KEY in the environment');

const handler = createWebhookHandler<WebhookEvent>(apiKey, (evt, { res }) => {
  const [domain, action] = evt.event.split('.');
  console.log(`OK ${evt.event}  (uuid=${(evt as { uuid?: string }).uuid ?? '-'})`);
  switch (domain) {
    case 'payout':
      // action: paid | system_fail -> reconcile your ledger
      break;
    case 'transaction':
      // action: confirmed | failed | expired
      break;
    case 'invoice':
      // pay-in lifecycle: paid | paid_over | paid_less | canceled | expired ...
      break;
    case 'static_deposit':
      // mempool | found | confirming | paid | reorged
      break;
    case 'sweep':
      // The one action is `confirmed`. A static_deposit.paid told you a
      // customer paid; this tells you the money has finished moving into your
      // own custody. Until it fires the balance still sits on the deposit
      // wallet, so treasury reporting keys off this, not off the deposit.
      onSweepConfirmed(evt as SweepWebhookEvent);
      break;
    default:
      console.log(`  (unhandled domain ${domain}/${action})`);
  }
  res.writeHead(200).end('ok');
});

function onSweepConfirmed(evt: SweepWebhookEvent): void {
  console.log(
    `  sweep ${evt.taskId}: ${evt.amountHuman} ${evt.assetSymbol} ` +
      `${evt.walletAddress} -> ${evt.toAddress} ` +
      `tx=${evt.sweepTxHash} confirmations=${evt.sweepConfirmations} ` +
      `trigger=${evt.typeWork} fee_usd=${evt.totalFeeUsd}`,
  );

  // taskId is the idempotency key: one sweep settles once. Seeing it twice
  // means a redelivery - acknowledge and stop.
  // if (await treasury.alreadyRecorded(evt.taskId)) return;

  // The event only ever arrives confirmed, but apply your own finality policy
  // here if you have one - "confirmed" is not the same number on every chain.
  // await treasury.recordSettled(evt.taskId, evt.assetSymbol, evt.amountHuman, evt.sweepTxHash);
  // await ledger.moveToAvailable(customerIdFor(evt.walletAddress), evt.assetSymbol, evt.amountHuman);
  // await costs.record(evt.taskId, evt.totalFeeUsd);  // sweeps are not free
}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    handler(req, res);
    return;
  }
  res.writeHead(404).end();
});

server.listen(3000, () => {
  console.log('webhook server on http://localhost:3000/webhook');
  console.log(`whitelist sender IPs at your edge: ${WEBHOOK_SENDER_IPS.join(', ')}`);
});
