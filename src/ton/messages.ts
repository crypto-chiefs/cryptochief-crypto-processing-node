import { Address, beginCell, type Cell } from '@ton/core';
import { CryptoChiefError } from '../errors';

/**
 * TON message-body builders. BoC (de)serialization is delegated to `@ton/core`;
 * the SDK does not encode cells by hand. These helpers produce the raw BoC bytes
 * the contract-call `data` field expects (base64-encoded by the caller).
 */

/** TON internal-message op codes from the public TIP/TEP standards. */
const OP_JETTON_TRANSFER = 0x0f8a7ea5; // TEP-74
const OP_NFT_TRANSFER = 0x5fcc3d14; // TEP-62
const OP_TEXT_COMMENT = 0x00000000;

const BOC_OPTS = { idx: false } as const;

/**
 * Parse any TON address form (user-friendly `EQ`/`UQ` or raw `workchain:hex`)
 * into the `@ton/core` `Address` the cell builders use.
 */
export function parseTonAddr(s: string): Address {
  try {
    return Address.parse(s);
  } catch (err) {
    throw new CryptoChiefError(
      `cryptochief/ton: invalid TON address ${JSON.stringify(s)} (expected EQ/UQ or workchain:hex): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Standard Jetton "transfer" body (TEP-74, op `0x0f8a7ea5`).
 *
 *   transfer#0f8a7ea5 query_id:uint64 amount:(VarUInteger 16)
 *     destination:MsgAddress response_destination:MsgAddress
 *     custom_payload:(Maybe ^Cell) forward_ton_amount:(VarUInteger 16)
 *     forward_payload:(Either Cell ^Cell) = InternalMsgBody;
 *
 * `destination` is the recipient's *main* TON wallet; the network handles the
 * wallet-to-wallet hop.
 */
export function buildJettonTransferBody(params: {
  queryId: bigint;
  amount: bigint;
  destination: Address;
  responseDest: Address | null;
  customPayload?: Cell | null;
  forwardTon: bigint;
  forwardPayload?: Cell | null;
}): Uint8Array {
  if (params.amount < 0n) throw new CryptoChiefError('cryptochief/ton: jetton amount must be non-negative');
  let b = beginCell()
    .storeUint(OP_JETTON_TRANSFER, 32)
    .storeUint(params.queryId, 64)
    .storeCoins(params.amount)
    .storeAddress(params.destination)
    .storeAddress(params.responseDest)
    .storeMaybeRef(params.customPayload ?? null)
    .storeCoins(params.forwardTon < 0n ? 0n : params.forwardTon);
  // forward_payload: Either Cell ^Cell - ref when supplied, empty-inline otherwise.
  b = params.forwardPayload ? b.storeBit(true).storeRef(params.forwardPayload) : b.storeBit(false);
  return new Uint8Array(b.endCell().toBoc(BOC_OPTS));
}

/** Standard NFT "transfer" body (TEP-62, op `0x5fcc3d14`). */
export function buildNftTransferBody(params: {
  queryId: bigint;
  newOwner: Address;
  responseDest: Address | null;
  customPayload?: Cell | null;
  forwardTon: bigint;
  forwardPayload?: Cell | null;
}): Uint8Array {
  let b = beginCell()
    .storeUint(OP_NFT_TRANSFER, 32)
    .storeUint(params.queryId, 64)
    .storeAddress(params.newOwner)
    .storeAddress(params.responseDest)
    .storeMaybeRef(params.customPayload ?? null)
    .storeCoins(params.forwardTon < 0n ? 0n : params.forwardTon);
  b = params.forwardPayload ? b.storeBit(true).storeRef(params.forwardPayload) : b.storeBit(false);
  return new Uint8Array(b.endCell().toBoc(BOC_OPTS));
}

/**
 * A standalone text-comment cell (op `0` + UTF-8 snake string). Used both as a
 * top-level body and as a Jetton transfer's `forward_payload` ref when a memo
 * is supplied.
 */
export function buildTextCommentCell(text: string): Cell {
  return beginCell().storeUint(OP_TEXT_COMMENT, 32).storeStringTail(text).endCell();
}

/** Simple text-comment body (what wallets show as the transfer note). */
export function buildTextCommentBody(text: string): Uint8Array {
  return new Uint8Array(buildTextCommentCell(text).toBoc(BOC_OPTS));
}
