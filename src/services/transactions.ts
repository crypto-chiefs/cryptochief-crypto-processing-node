import type { Chain } from '../chains';
import type { RequestOptions } from '../client';
import type { HistoryMeta, HistoryQuery } from '../pagination';
import { waitForTerminal, type PollOptions } from '../poll';
import { CryptoChiefError } from '../errors';
import { encodeEvmCallHex } from '../contract/evm-abi';
import { encodeAnchorInstruction, type BorshValue } from '../contract/borsh';
import {
  buildJettonTransferBody,
  buildNftTransferBody,
  buildTextCommentBody,
  buildTextCommentCell,
  parseTonAddr,
} from '../ton/messages';
import { BaseService } from './base';

/** Transaction type discriminator the API uses to pick a signing path. */
export const TxType = {
  /** Native-asset transfer. Body: `toAddress` + `value`. */
  Native: 'native',
  /** ERC-20-style token transfer. Body: `toAddress` + `value` + `contract`. */
  Token: 'token',
  /** Arbitrary contract call(s). Body: `calls[]`. EVM/TRON/Solana/TON only. */
  Contract: 'contract',
} as const;
export type TxType = (typeof TxType)[keyof typeof TxType];

/** Transaction status values. */
export const TxStatus = {
  Signed: 'signed',
  Broadcasting: 'broadcasting',
  Broadcasted: 'broadcasted',
  Confirmed: 'confirmed',
  Failed: 'failed',
  Expired: 'expired',
} as const;

const TERMINAL = new Set<string>([TxStatus.Confirmed, TxStatus.Failed, TxStatus.Expired]);

/** Whether a transaction status is final. */
export function isTransactionTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

/** Solana account meta (mirrors `AccountMeta`). */
export interface SolanaAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * One instruction in a contract-type request. Per-family encoding:
 *  - EVM/TRON - `data` is hex calldata (`0x...`), single call.
 *  - TON - `data` is a base64 BoC body cell, single call, `bounce` defaults true.
 *  - Solana - `to` is the program id, `data` base64 instruction data, `accounts`
 *    lists the metas; multiple instructions allowed (only `fromAddress` signs).
 */
export interface ContractCall {
  to: string;
  value?: string;
  data: string;
  accounts?: SolanaAccount[];
  bounce?: boolean;
}

export interface SignTransactionRequest {
  network: Chain;
  fromAddress: string;
  type: TxType;
  /** Transfer-mode (native/token). */
  toAddress?: string;
  /** Transfer-mode value in BASE units (e.g. wei) as a decimal string. */
  value?: string;
  /** Token contract for `token` type. */
  contract?: string;
  /** Contract-mode instructions. */
  calls?: ContractCall[];
  /** Receives transaction.* webhooks. */
  urlCallback?: string;
}

export interface SignTransactionResponse {
  uuid: string;
  status: string;
  signedTxHex: string;
  txHash: string;
  expiresAt: string;
  chainFamily: string;
  network?: Chain;
}

export interface ExecuteTransactionRequest {
  uuid: string;
  /** Optional - only used for a client-vs-server byte-match check. */
  signedTxHex?: string;
}

export interface TransactionInfo {
  uuid: string;
  status: string;
  network: Chain;
  chainFamily?: string;
  fromAddress: string;
  toAddress?: string;
  type?: TxType;
  value?: string;
  coin?: string;
  contract?: string;
  txHash?: string;
  signedTxHex?: string;
  expiresAt?: string;
  nonce?: number;
  actualFee?: string;
  actualFeeFiat?: string;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
}

export interface TransactionHistoryResponse {
  items: TransactionInfo[];
  meta: HistoryMeta;
}

// -- High-level contract-call request shapes ----------------------------------

/** EVM / TRON contract call by Solidity-style signature. */
export interface EvmCallRequest {
  network: Chain;
  fromAddress: string;
  /** Contract address (0x hex for EVM; `T...` base58 or 0x41 hex for TRON). */
  contract: string;
  /** Canonical signature, e.g. `"transfer(address,uint256)"`. */
  method: string;
  /** Arguments in signature order. */
  args: unknown[];
  /** Native value attached (base units). Empty/`"0"` sends nothing. */
  value?: string;
  urlCallback?: string;
}

export interface Erc20TransferRequest {
  network: Chain;
  fromAddress: string;
  tokenContract: string;
  recipient: string;
  /** Token base units (use `humanToBase` with the token's decimals). */
  amount: bigint | number | string;
  urlCallback?: string;
}

export interface AnchorCallRequest {
  network: Chain;
  fromAddress: string;
  program: string;
  method: string;
  args: BorshValue[];
  accounts: SolanaAccount[];
  urlCallback?: string;
}

export interface SolanaCallRequest {
  network: Chain;
  fromAddress: string;
  program: string;
  instructionData: Uint8Array;
  accounts: SolanaAccount[];
  urlCallback?: string;
}

export interface TonCallRequest {
  network: Chain;
  fromAddress: string;
  contract: string;
  /** Raw BoC bytes; base64-encoded internally. */
  bodyCell: Uint8Array;
  value?: string | bigint;
  bounce?: boolean;
  urlCallback?: string;
}

export interface JettonTransferRequest {
  network: Chain;
  /** Sender's TON wallet (owns the Jetton wallet). */
  fromAddress: string;
  /** Jetton master contract address (the token's ID). */
  jettonMaster: string;
  /** Optional pre-resolved sender Jetton wallet. If omitted, resolved via RPC. */
  jettonWalletAddress?: string;
  /** Recipient's *main* TON wallet (not their Jetton wallet). */
  recipient: string;
  /** Jetton amount in base units. */
  amount: bigint;
  /** Receives unused gas. Defaults to `fromAddress`. */
  responseDestination?: string;
  /** Gas budget in nanoTON. Auto-picked (0.07 / 0.15 TON) when omitted. */
  attachedTon?: bigint;
  /** Forwarded to the recipient's notify handler (nanoTON). Defaults to 1 when `memo` is set, else 0. */
  forwardTonAmount?: bigint;
  /** Optional comment shown by wallets (encoded as the forward payload). */
  memo?: string;
  queryId?: bigint;
  urlCallback?: string;
}

export interface NftTransferRequest {
  network: Chain;
  fromAddress: string;
  nftItem: string;
  newOwner: string;
  responseDestination?: string;
  attachedTon?: bigint;
  forwardTonAmount?: bigint;
  queryId?: bigint;
  urlCallback?: string;
}

export interface TonCommentRequest {
  network: Chain;
  fromAddress: string;
  recipient: string;
  text: string;
  /** Amount to send in nanoTON. */
  amountTon?: bigint;
  urlCallback?: string;
}

const JETTON_ATTACHED_EXISTING_WALLET = 70_000_000n; // 0.07 TON
const JETTON_ATTACHED_NEW_WALLET = 150_000_000n; // 0.15 TON
const NFT_ATTACHED_DEFAULT = 50_000_000n; // 0.05 TON

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function valueString(v: string | bigint | undefined): string {
  if (v === undefined || v === '') return '0';
  return typeof v === 'bigint' ? v.toString() : v;
}

/**
 * Two-phase sign/execute for arbitrary merchant-owned transactions, plus
 * one-call helpers for EVM/TRON contracts, Solana Anchor programs, and TON
 * Jetton/NFT/comment transfers.
 */
export class TransactionsService extends BaseService {
  /**
   * Build and sign a transaction WITHOUT broadcasting. The signature has a
   * per-family TTL (EVM 10m, UTXO 15m, TRON 45s, Solana 60s, XRP 90s, TON 300s)
   * - call `execute` before it elapses.
   */
  sign(req: SignTransactionRequest, opts?: RequestOptions): Promise<SignTransactionResponse> {
    return this.call('/v1/transaction/signature', req, opts);
  }

  /** Broadcast a previously-signed transaction by uuid. */
  execute(req: ExecuteTransactionRequest, opts?: RequestOptions): Promise<TransactionInfo> {
    return this.call('/v1/transaction/execute', req, opts);
  }

  /** Fetch the current state of one transaction by uuid. */
  info(uuid: string, opts?: RequestOptions): Promise<TransactionInfo> {
    return this.call('/v1/transaction/info', { uuid }, opts);
  }

  /** Paged list of merchant-owned transactions. */
  history(query: HistoryQuery = {}, opts?: RequestOptions): Promise<TransactionHistoryResponse> {
    return this.call('/v1/transaction/history', query, opts);
  }

  /** Poll `info` until the transaction reaches a terminal state (or timeout). */
  waitFor(uuid: string, opts: PollOptions = {}): Promise<TransactionInfo> {
    return waitForTerminal(
      (signal) => this.info(uuid, { signal }),
      (t) => isTransactionTerminal(t.status),
      opts,
    );
  }

  // -- Contract-call helpers --------------------------------------------------

  /** Sign an EVM/TRON contract call, ABI-encoding `data` from the signature + args. */
  signEvmCall(req: EvmCallRequest, opts?: RequestOptions): Promise<SignTransactionResponse> {
    let data: string;
    try {
      data = encodeEvmCallHex(req.method, ...req.args);
    } catch (err) {
      throw new CryptoChiefError(
        `cryptochief: encode call ${JSON.stringify(req.method)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.sign(
      {
        network: req.network,
        fromAddress: req.fromAddress,
        type: TxType.Contract,
        urlCallback: req.urlCallback,
        calls: [{ to: req.contract, value: valueString(req.value), data }],
      },
      opts,
    );
  }

  /** Alias for {@link signEvmCall} - TRON shares the EVM ABI encoding. */
  signTronCall(req: EvmCallRequest, opts?: RequestOptions): Promise<SignTransactionResponse> {
    return this.signEvmCall(req, opts);
  }

  /** One-liner for an ERC-20 / TRC-20 `transfer(address,uint256)`. */
  erc20Transfer(req: Erc20TransferRequest, opts?: RequestOptions): Promise<SignTransactionResponse> {
    return this.signEvmCall(
      {
        network: req.network,
        fromAddress: req.fromAddress,
        contract: req.tokenContract,
        method: 'transfer(address,uint256)',
        args: [req.recipient, req.amount],
        urlCallback: req.urlCallback,
      },
      opts,
    );
  }

  /** Sign an Anchor program call (8-byte discriminator + Borsh-encoded args). */
  signAnchorCall(req: AnchorCallRequest, opts?: RequestOptions): Promise<SignTransactionResponse> {
    let data: Uint8Array;
    try {
      data = encodeAnchorInstruction(req.method, ...req.args);
    } catch (err) {
      throw new CryptoChiefError(
        `cryptochief: encode anchor instruction ${JSON.stringify(req.method)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return this.sign(
      {
        network: req.network,
        fromAddress: req.fromAddress,
        type: TxType.Contract,
        urlCallback: req.urlCallback,
        calls: [{ to: req.program, data: toBase64(data), accounts: req.accounts }],
      },
      opts,
    );
  }

  /** Sign a non-Anchor Solana program call with raw instruction bytes. */
  signSolanaCall(req: SolanaCallRequest, opts?: RequestOptions): Promise<SignTransactionResponse> {
    return this.sign(
      {
        network: req.network,
        fromAddress: req.fromAddress,
        type: TxType.Contract,
        urlCallback: req.urlCallback,
        calls: [{ to: req.program, data: toBase64(req.instructionData), accounts: req.accounts }],
      },
      opts,
    );
  }

  /** Sign a TON contract call from a pre-built BoC body cell. */
  signTonCall(req: TonCallRequest, opts?: RequestOptions): Promise<SignTransactionResponse> {
    return this.sign(
      {
        network: req.network,
        fromAddress: req.fromAddress,
        type: TxType.Contract,
        urlCallback: req.urlCallback,
        calls: [
          {
            to: req.contract,
            value: valueString(req.value),
            data: toBase64(req.bodyCell),
            bounce: req.bounce,
          },
        ],
      },
      opts,
    );
  }

  /**
   * Transfer Jetton tokens. Builds the TEP-74 transfer body, resolves the
   * sender's Jetton wallet (via RPC if not supplied), and picks a sensible gas
   * budget automatically.
   */
  async jettonTransfer(req: JettonTransferRequest, opts?: RequestOptions): Promise<SignTransactionResponse> {
    if (!req.recipient) throw new CryptoChiefError('cryptochief: jettonTransfer: recipient required');
    if (!req.jettonMaster && !req.jettonWalletAddress) {
      throw new CryptoChiefError('cryptochief: jettonTransfer: jettonMaster or jettonWalletAddress required');
    }
    const rpc = this.client.tonRpc();

    const jettonWallet =
      req.jettonWalletAddress || (await rpc.lookupJettonWallet(req.jettonMaster, req.fromAddress));

    const destination = parseTonAddr(req.recipient);
    const responseDest = parseTonAddr(req.responseDestination || req.fromAddress);
    const forwardPayload = req.memo ? buildTextCommentCell(req.memo) : null;
    const forwardTon = req.forwardTonAmount ?? (req.memo ? 1n : 0n);

    const bodyCell = buildJettonTransferBody({
      queryId: req.queryId ?? 0n,
      amount: req.amount,
      destination,
      responseDest,
      forwardTon,
      forwardPayload,
    });

    let attached = req.attachedTon;
    if (attached === undefined) {
      attached = JETTON_ATTACHED_NEW_WALLET;
      if (req.jettonMaster && (await rpc.hasJettonWallet(req.jettonMaster, req.recipient))) {
        attached = JETTON_ATTACHED_EXISTING_WALLET;
      }
    }

    return this.signTonCall(
      {
        network: req.network,
        fromAddress: req.fromAddress,
        contract: jettonWallet,
        bodyCell,
        value: attached,
        bounce: true,
        urlCallback: req.urlCallback,
      },
      opts,
    );
  }

  /** Transfer ownership of an NFT item (TEP-62 transfer body). */
  nftTransfer(req: NftTransferRequest, opts?: RequestOptions): Promise<SignTransactionResponse> {
    if (!req.nftItem || !req.newOwner) {
      throw new CryptoChiefError('cryptochief: nftTransfer: nftItem and newOwner required');
    }
    const newOwner = parseTonAddr(req.newOwner);
    const responseDest = parseTonAddr(req.responseDestination || req.fromAddress);
    const bodyCell = buildNftTransferBody({
      queryId: req.queryId ?? 0n,
      newOwner,
      responseDest,
      forwardTon: req.forwardTonAmount ?? 0n,
    });
    return this.signTonCall(
      {
        network: req.network,
        fromAddress: req.fromAddress,
        contract: req.nftItem,
        bodyCell,
        value: req.attachedTon ?? NFT_ATTACHED_DEFAULT,
        bounce: true,
        urlCallback: req.urlCallback,
      },
      opts,
    );
  }

  /** Send TON with a text comment (the note every wallet displays). */
  sendTonComment(req: TonCommentRequest, opts?: RequestOptions): Promise<SignTransactionResponse> {
    if (!req.recipient) throw new CryptoChiefError('cryptochief: sendTonComment: recipient required');
    const bodyCell = buildTextCommentBody(req.text);
    return this.signTonCall(
      {
        network: req.network,
        fromAddress: req.fromAddress,
        contract: req.recipient,
        bodyCell,
        value: req.amountTon ?? 0n,
        bounce: false,
        urlCallback: req.urlCallback,
      },
      opts,
    );
  }
}
