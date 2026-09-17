/**
 * webhook-server - a minimal Node HTTP server that verifies webhooks
 * (HMAC-SHA256 v1 over the raw body: `X-CC-Timestamp`, `X-Webhook-Delivery`,
 * `X-CC-Signature`) and dispatches typed events.
 *
 *   API_KEY=... PORT=3000 npx tsx examples/webhook-server.ts
 *
 * Express alternative (mount express.raw so the body stays untouched):
 *   app.post('/webhook', express.raw({ type: '*\/*' }), (req, res) => {
 *     let evt: WebhookEvent;
 *     try {
 *       evt = parseWebhookEvent(apiKey, req.body, req.headers);
 *     } catch (err) {
 *       res.sendStatus(err instanceof WebhookVerificationError ? 401 : 400);
 *       return;
 *     }
 *     // ... handle evt ...
 *     res.sendStatus(200);
 *   });
 */
import { createServer } from 'node:http';
import {
  createWebhookHandler,
  WEBHOOK_HEADERS,
  WEBHOOK_SENDER_IPS,
  type WebhookEvent,
  type SweepWebhookEvent,
} from '../src/index';

const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error('set API_KEY in the environment');
const port = Number(process.env.PORT ?? 3000);

// Invalid webhooks never reach this callback: the handler answers them 401.
const handler = createWebhookHandler<WebhookEvent>(apiKey, (evt, { req, res }) => {
  const [domain, action] = evt.event.split('.');
  // The delivery id is the same on every attempt and resend: deduplicate on it.
  const delivery = req.headers[WEBHOOK_HEADERS.delivery.toLowerCase()];
  console.log(`OK ${evt.event}  (delivery=${delivery}, uuid=${(evt as { uuid?: string }).uuid ?? '-'})`);
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
      `tx=${evt.sweepTxHash} confirmations=${evt.sweepConfirmations}/${evt.requiredConfirmations ?? '-'} ` +
      `trigger=${evt.typeWork} fee_usd=${evt.totalFeeUsd}`,
  );

  // taskId is the idempotency key: one sweep settles once. Seeing it twice
  // means a redelivery - acknowledge and stop.
  // if (await treasury.alreadyRecorded(evt.taskId)) return;

  // The event arrives at the network's finality depth. Apply a stricter policy
  // here if you have one.
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

server.listen(port, () => {
  console.log(`webhook server on http://localhost:${port}/webhook`);
  console.log(`whitelist sender IPs at your edge: ${WEBHOOK_SENDER_IPS.join(', ')}`);
});
