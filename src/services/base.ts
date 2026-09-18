import type { CryptoChiefClient, RequestOptions } from '../client';
import { fromWire, toWire } from '../case';
import { ApiError } from '../errors';

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

  /**
   * Recovery for the paid order-creating calls (energy rent, native buy). A
   * business outcome that produced an order answers non-2xx - 502 (refused),
   * 409 (unresolved), 402 (refused: credits balance short) - with the order
   * itself as the body, not a transport failure. Recover it; anything else (an
   * `ok:false` error envelope, a gateway error page) is for the caller to catch.
   */
  protected recoverOrder<T>(err: unknown): T | undefined {
    if (!(err instanceof ApiError)) return undefined;
    if (err.httpStatus !== 402 && err.httpStatus !== 409 && err.httpStatus !== 502) return undefined;
    if (!err.raw) return undefined;
    let data: unknown;
    try {
      data = JSON.parse(err.raw);
    } catch {
      return undefined;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
    const body = data as Record<string, unknown>;
    if (!('id' in body) || !('status' in body)) return undefined;
    return fromWire(body) as T;
  }
}
