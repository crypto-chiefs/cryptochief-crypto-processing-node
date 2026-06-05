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
import { createWebhookHandler, WEBHOOK_SENDER_IPS, type WebhookEvent } from '../src/index';

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
    default:
      console.log(`  (unhandled domain ${domain}/${action})`);
  }
  res.writeHead(200).end('ok');
});

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
