import { describe, expect, it } from 'vitest';
import { handler } from '../../netlify/functions/api.ts';

describe('Netlify Express API function', () => {
  it.each(['/api/auth/signup', '/.netlify/functions/api/auth/signup'])(
    'routes POST %s through to the signup API',
    async (path) => {
      const response = (await handler(
        {
          httpMethod: 'POST',
          path,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
          isBase64Encoded: false,
        },
        {}
      )) as { statusCode: number; body: string };

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error.code).toBe('VALIDATION_ERROR');
    }
  );
});
