import type { Chain } from './chains';

/**
 * A specific coin on a specific network. Appears inside asset-selection
 * policies - the auto-convert source filter on payouts and the allowed-asset
 * list on FIAT-mode pay-ins.
 *
 * `network` takes a chain code (e.g. `Chain.EthMainnet`) or the wildcard
 * `"ANY"`; `coin` is the symbol (e.g. `"USDT"`). Either field may be omitted to
 * mean "any".
 */
export interface Asset {
  network?: Chain | 'ANY';
  coin?: string;
}

/**
 * An allow/exclude filter over {@link Asset} entries. Omitting both lists means
 * "no restriction". Used for payout auto-convert source selection and to
 * restrict which coins a FIAT-mode pay-in customer may pick.
 */
export interface AssetsPolicy {
  allow?: Asset[];
  exclude?: Asset[];
}
