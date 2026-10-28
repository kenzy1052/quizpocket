import { Request, Response, NextFunction } from 'express';

interface Bucket {
  timestamps: number[];
}

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}

/**
 * Sliding-window rate limiter protecting authentication, attempt creation,
 * and export routes against brute-force or abusive bursts.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const clientIp =
      (typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for'].split(',')[0]?.trim()
        : null) ||
      req.ip ||
      'unknown';

    const key = `${options.keyPrefix}:${clientIp}`;
    const existing = buckets.get(key) ?? { timestamps: [] };
    const cutoff = now - options.windowMs;

    existing.timestamps = existing.timestamps.filter((ts) => ts > cutoff);

    if (existing.timestamps.length >= options.maxRequests) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((existing.timestamps[0] + options.windowMs - now) / 1000)
      );
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please wait before trying again.',
        },
      });
      return;
    }

    existing.timestamps.push(now);
    buckets.set(key, existing);

    // Opportunistic cleanup to bound memory growth
    if (buckets.size > 5000) {
      for (const [k, b] of buckets.entries()) {
        if (b.timestamps.every((ts) => ts <= cutoff)) {
          buckets.delete(k);
        }
      }
    }

    next();
  };
}
