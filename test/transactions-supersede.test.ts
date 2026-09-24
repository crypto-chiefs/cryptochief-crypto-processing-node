import { describe, it, expect } from 'vitest';
import { CryptoChiefClient } from '../src/client';
import { ApiError, ErrorCode } from '../src/errors';
import { TxStatus, TxType, isTransactionTerminal } from '../src/services/transactions';

// EVM signature supersede: the `cancelled` status, `supersededUuids` on the
// sign answer, `errorReason` on the transaction, and the new error codes.

const OLD = '0c1d9f3e-5a7b-4c2e-9f1a-3b6d8e2f4a10';
const NEW = 'b4ee6a7a-f7c2-474d-b002-e83ebe3e78db';

function makeClient(handler: () => Response) {
  let calls = 0;
  const fetchMock = async (): Promise<Response> => {
    calls++;
    return handler();
  };
  const client = new CryptoChiefClient({
    merchantId: 'M1',
    apiKey: 'secret',
    fetch: fetchMock,
    retryBackoff: { baseMs: 1, maxMs: 2 },
  });
  return { client, calls: () => calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const signReq = {
  network: 'ETH_MAINNET' as const,
  fromAddress: '0xfrom',
  type: TxType.Native,
  toAddress: '0xto',
  value: '1',
};

describe('signature supersede', () => {
  it('treats cancelled as final', () => {
    expect(TxStatus.Cancelled).toBe('cancelled');
    expect(isTransactionTerminal('cancelled')).toBe(true);
    for (const live of ['signed', 'broadcasting', 'broadcasted']) {
      expect(isTransactionTerminal(live)).toBe(false);
    }
  });

  it('waitFor returns a superseded signature instead of polling to the timeout', async () => {
    const { client, calls } = makeClient(() =>
      json(200, { uuid: OLD, status: 'cancelled', error_reason: `SUPERSEDED_BY:${NEW}` }),
    );

    const out = await client.transactions.waitFor(OLD, { intervalMs: 10, timeoutMs: 200 });

    expect(out.status).toBe(TxStatus.Cancelled);
    expect(out.errorReason).toBe(`SUPERSEDED_BY:${NEW}`);
    expect(calls()).toBe(1);
  });

  it('reads the replaced signatures from the sign answer', async () => {
    const { client } = makeClient(() =>
      json(200, {
        uuid: NEW,
        status: 'signed',
        network: 'ETH_MAINNET',
        chain_family: 'EVM',
        signed_tx_hex: '0x02',
        tx_hash: '0xabc',
        expires_at: '2026-06-01T12:10:00Z',
        superseded_uuids: [OLD],
      }),
    );

    const out = await client.transactions.sign(signReq);

    expect(out.supersededUuids).toEqual([OLD]);
  });

  it('reads error_reason of a signed transaction held by a nonce gap', async () => {
    const reason = `NONCE_GAP: missing_nonce=7 blocking_uuid=${OLD}`;
    const { client } = makeClient(() => json(200, { uuid: NEW, status: 'signed', error_reason: reason }));

    const out = await client.transactions.info(NEW);

    expect(out.errorReason).toBe(reason);
  });

  it.each([
    ['NONCE_GAP', ErrorCode.NonceGap],
    ['NONCE_ALREADY_USED', ErrorCode.NonceAlreadyUsed],
  ])('surfaces %s from execute', async (msg, code) => {
    const { client } = makeClient(() => json(400, { error: 'SERVICE_ERROR', msg, ok: false }));

    const err = await client.transactions.execute({ uuid: NEW }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
    expect((err as ApiError).httpStatus).toBe(400);
  });

  it('surfaces PREVIOUS_EXECUTE_UNRESOLVED from sign with the unresolved uuid', async () => {
    const { client } = makeClient(() =>
      json(400, { error: 'SERVICE_ERROR', msg: `PREVIOUS_EXECUTE_UNRESOLVED: uuid=${OLD}`, ok: false }),
    );

    const err = await client.transactions.sign(signReq).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code.startsWith(ErrorCode.PreviousExecuteUnresolved)).toBe(true);
    expect((err as ApiError).code.endsWith(OLD)).toBe(true);
  });
});
