import type { CryptoChiefClient, RequestOptions } from '../client';
import { fromWire, toWire } from '../case';

/**
 * Shared base for domain services. Holds the client reference and wraps
 * {@link CryptoChiefClient.request} with camelCase <-> snake_case conversion so
 * each service method stays a one-liner.
 */
export abstract class BaseService {
  constructor(protected readonly client: CryptoChiefClient) {}

  /** Signed POST with automatic case conversion of body and response. */
  protected async call<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    const raw = await this.client.request<unknown>(path, toWire(body), opts);
    return fromWire(raw) as T;
  }
}
