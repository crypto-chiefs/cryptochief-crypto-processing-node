/**
 * Chain codes and protocol families.
 *
 * {@link Chain} is the value of the `network` / `chain` / `network_code` fields
 * across the API; {@link ChainFamily} (the `chain_family` field) groups chains
 * by underlying protocol and drives capability checks such as "does this chain
 * accept contract calls?".
 */

/** All chain codes the API currently supports. */
export const Chain = {
  EthMainnet: 'ETH_MAINNET',
  EthSepolia: 'ETH_SEPOLIA',
  BscMainnet: 'BSC_MAINNET',
  BscTestnet: 'BSC_TESTNET',
  PolygonMainnet: 'POLYGON_MAINNET',
  PolygonAmoy: 'POLYGON_AMOY',
  ArbitrumOne: 'ARBITRUM_ONE',
  ArbitrumSepolia: 'ARBITRUM_SEPOLIA',
  OptimismMainnet: 'OPTIMISM_MAINNET',
  OptimismSepolia: 'OPTIMISM_SEPOLIA',
  AvaxMainnet: 'AVAX_MAINNET',
  AvaxTestnet: 'AVAX_TESTNET',

  BtcMainnet: 'BTC_MAINNET',
  BtcTestnet: 'BTC_TESTNET_4',
  Litecoin: 'LITECOIN_MAINNET',
  BitcoinCash: 'BITCOIN_CASH_MAINNET',
  Dogecoin: 'DOGECOIN_MAINNET',

  TronMainnet: 'TRON_MAINNET',
  TronNile: 'TRON_NILE',

  SolanaMainnet: 'SOLANA_MAINNET',
  SolanaDevnet: 'SOLANA_DEVNET',

  TonMainnet: 'TON_MAINNET',
  TonTestnet: 'TON_TESTNET',

  XrpMainnet: 'XRP_MAINNET',
  XrpTestnet: 'XRP_TESTNET',
} as const;

/**
 * A chain code. The named {@link Chain} constants are the supported set, but
 * any string is accepted at the type level so new chains work before this SDK
 * is updated.
 */
export type Chain = (typeof Chain)[keyof typeof Chain] | (string & {});

/** Protocol families (the `chain_family` field in API responses). */
export const ChainFamily = {
  Evm: 'EVM',
  Tron: 'TRON',
  Solana: 'SOLANA',
  XrpLedger: 'XRP_LEDGER',
  Ton: 'TON',
  BtcUtxo: 'BTC_UTXO',
  BtcUtxoTestnet: 'BTC_UTXO_TESTNET',
  DogecoinUtxo: 'DOGECOIN_UTXO',
  BitcoinCashUtxo: 'BTC_CASH_UTXO',
  LitecoinUtxo: 'LITECOIN_UTXO',
} as const;

/** A protocol family. */
export type ChainFamily = (typeof ChainFamily)[keyof typeof ChainFamily] | (string & {});

const CHAIN_TO_FAMILY: Record<string, ChainFamily> = {
  [Chain.EthMainnet]: ChainFamily.Evm,
  [Chain.EthSepolia]: ChainFamily.Evm,
  [Chain.BscMainnet]: ChainFamily.Evm,
  [Chain.BscTestnet]: ChainFamily.Evm,
  [Chain.PolygonMainnet]: ChainFamily.Evm,
  [Chain.PolygonAmoy]: ChainFamily.Evm,
  [Chain.ArbitrumOne]: ChainFamily.Evm,
  [Chain.ArbitrumSepolia]: ChainFamily.Evm,
  [Chain.OptimismMainnet]: ChainFamily.Evm,
  [Chain.OptimismSepolia]: ChainFamily.Evm,
  [Chain.AvaxMainnet]: ChainFamily.Evm,
  [Chain.AvaxTestnet]: ChainFamily.Evm,

  [Chain.BtcMainnet]: ChainFamily.BtcUtxo,
  [Chain.BtcTestnet]: ChainFamily.BtcUtxoTestnet,
  [Chain.Litecoin]: ChainFamily.LitecoinUtxo,
  [Chain.BitcoinCash]: ChainFamily.BitcoinCashUtxo,
  [Chain.Dogecoin]: ChainFamily.DogecoinUtxo,

  [Chain.TronMainnet]: ChainFamily.Tron,
  [Chain.TronNile]: ChainFamily.Tron,
  [Chain.SolanaMainnet]: ChainFamily.Solana,
  [Chain.SolanaDevnet]: ChainFamily.Solana,
  [Chain.TonMainnet]: ChainFamily.Ton,
  [Chain.TonTestnet]: ChainFamily.Ton,
  [Chain.XrpMainnet]: ChainFamily.XrpLedger,
  [Chain.XrpTestnet]: ChainFamily.XrpLedger,
};

/** Return the protocol family for a chain, or `undefined` if unrecognized. */
export function chainFamily(chain: Chain): ChainFamily | undefined {
  return CHAIN_TO_FAMILY[chain];
}

/**
 * Report whether a chain family accepts the `contract` transaction type with a
 * `calls[]` body. Only EVM, TRON, Solana, and TON do.
 */
export function supportsContractCalls(family: ChainFamily): boolean {
  return (
    family === ChainFamily.Evm ||
    family === ChainFamily.Tron ||
    family === ChainFamily.Solana ||
    family === ChainFamily.Ton
  );
}
