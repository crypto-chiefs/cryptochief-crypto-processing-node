import { describe, it, expect } from 'vitest';
import { Cell } from '@ton/core';
import {
  buildJettonTransferBody,
  buildNftTransferBody,
  buildTextCommentBody,
  buildTextCommentCell,
  parseTonAddr,
} from '../src/ton/messages';

const RECIPIENT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

describe('TON message bodies (built with @ton/core, re-parsed for verification)', () => {
  it('Jetton transfer body - op 0x0f8a7ea5, amount + destination survive', () => {
    const dest = parseTonAddr(RECIPIENT);
    const boc = buildJettonTransferBody({
      queryId: 0n,
      amount: 12_500_000n,
      destination: dest,
      responseDest: dest,
      forwardTon: 1n,
      forwardPayload: buildTextCommentCell('Order #4242'),
    });
    const slice = Cell.fromBoc(Buffer.from(boc))[0]!.beginParse();
    expect(slice.loadUint(32)).toBe(0x0f8a7ea5);
    expect(slice.loadUintBig(64)).toBe(0n); // query id
    expect(slice.loadCoins()).toBe(12_500_000n); // amount
    expect(slice.loadAddress().toString()).toBe(dest.toString()); // destination
    slice.loadAddress(); // response destination
    expect(slice.loadMaybeRef()).toBeNull(); // custom payload
    expect(slice.loadCoins()).toBe(1n); // forward ton
    expect(slice.loadBit()).toBe(true); // forward payload as ref
  });

  it('NFT transfer body - op 0x5fcc3d14, new owner survives', () => {
    const owner = parseTonAddr(RECIPIENT);
    const boc = buildNftTransferBody({ queryId: 7n, newOwner: owner, responseDest: owner, forwardTon: 0n });
    const slice = Cell.fromBoc(Buffer.from(boc))[0]!.beginParse();
    expect(slice.loadUint(32)).toBe(0x5fcc3d14);
    expect(slice.loadUintBig(64)).toBe(7n);
    expect(slice.loadAddress().toString()).toBe(owner.toString());
  });

  it('text comment body - op 0 + snake string', () => {
    const slice = Cell.fromBoc(Buffer.from(buildTextCommentBody('Thanks for the coffee!')))[0]!.beginParse();
    expect(slice.loadUint(32)).toBe(0);
    expect(slice.loadStringTail()).toBe('Thanks for the coffee!');
  });
});
