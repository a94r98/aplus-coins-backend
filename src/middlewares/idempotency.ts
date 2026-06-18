import { Request, Response, NextFunction } from 'express';
import { query } from '../config/db';

export const idempotency = async (req: Request, res: Response, next: NextFunction) => {
  const key = req.headers['x-idempotency-key'] as string;
  if (!key) {
    return next();
  }

  try {
    try {
      // Try to reserve the key immediately as PROCESSING to prevent parallel/replay race conditions
      await query(
        'INSERT INTO idempotency_keys (key, response_code, response_body) VALUES ($1, 102, $2)',
        [key, 'PROCESSING']
      );
    } catch (err: any) {
      if (err.code === '23505') { // PostgreSQL unique violation code
        // Key already exists. Fetch the state/result.
        const result = await query(
          'SELECT response_code, response_body FROM idempotency_keys WHERE key = $1',
          [key]
        );
        if (result.rowCount && result.rowCount > 0) {
          const cached = result.rows[0];
          if (cached.response_body === 'PROCESSING') {
            return res.status(409).json({
              status: 'error',
              message: 'This request is already being processed. Please wait.',
            });
          }
          try {
            const bodyObj = JSON.parse(cached.response_body);
            return res.status(cached.response_code).json(bodyObj);
          } catch (parseErr) {
            return res.status(cached.response_code).send(cached.response_body);
          }
        }
      }
      return next(err);
    }

    // Intercept response to store the final outcome
    const originalJson = res.json;
    res.json = function (body: any): Response {
      res.json = originalJson;
      const statusCode = res.statusCode;
      const bodyStr = JSON.stringify(body);

      query(
        'UPDATE idempotency_keys SET response_code = $1, response_body = $2 WHERE key = $3',
        [statusCode, bodyStr, key]
      ).catch((err) => {
        console.error('Failed to update idempotency key:', err);
      });

      return originalJson.call(this, body);
    };

    next();
  } catch (error) {
    next(error);
  }
};
