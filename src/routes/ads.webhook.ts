import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool, query } from '../config/db';
import { WalletService } from '../services/wallet.service';
import { AppError } from '../middlewares/error';

const router = Router();

async function processS2SReward(
  userId: number,
  providerKey: string,
  amount: number,
  ip: string,
  transactionId: string,
  signature: string
) {
  const todayStr = new Date().toISOString().split('T')[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Check user exists and lock user row
    const userResult = await client.query(
      'SELECT id, pending_balance, available_balance, is_blocked FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (!userResult.rowCount) {
      throw new AppError('User not found', 404);
    }
    const user = userResult.rows[0];
    if (user.is_blocked) {
      throw new AppError('User account is blocked', 403);
    }

    // 2. Insert into ad_logs
    // We generate a deterministic adId and requestHash from transactionId / signature to prevent replay attacks
    const adId = `${providerKey.toLowerCase()}_s2s_${transactionId}`;
    const requestHash = crypto.createHash('sha256').update(`${providerKey}_${transactionId}_${signature}`).digest('hex');

    try {
      await client.query(
        `INSERT INTO ad_logs (user_id, ad_id, reward_amount, request_hash, device_fingerprint, is_suspicious, watched_date) 
         VALUES ($1, $2, $3, $4, $5, FALSE, $6)`,
        [userId, adId, amount, requestHash, 'S2S_CALLBACK', todayStr]
      );
    } catch (err: any) {
      // If error is unique key violation (23505), it's a duplicate callback (replay attack)
      if (err.code === '23505') {
        throw new AppError('Duplicate transaction. Replay attack blocked.', 409);
      }
      throw err;
    }

    // 3. Update wallet using WalletService.logAndGetWalletUpdate
    const rewardMicro = BigInt(Math.round(amount * 1000000));
    const currentPb = BigInt(user.pending_balance || 0);
    await WalletService.logAndGetWalletUpdate(
      client,
      userId,
      'AD_REWARD_S2S',
      amount,
      { pending_balance: currentPb + rewardMicro },
      `S2S callback reward from ${providerKey}. Transaction: ${transactionId}`
    );

    // 4. Update daily control
    await client.query(
      `INSERT INTO daily_control (user_id, date, ads_watched, reward_generated)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (user_id, date) DO UPDATE
       SET ads_watched = daily_control.ads_watched + 1,
           reward_generated = daily_control.reward_generated + EXCLUDED.reward_generated`,
      [userId, todayStr, amount]
    );

    // 5. Update total revenue generated for the provider
    await client.query(
      `UPDATE ad_providers 
       SET total_revenue = total_revenue + $1 
       WHERE provider_key = $2`,
      [amount, providerKey]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// CPAlead webhook signature verification:
// GET /ads/webhooks/cpalead?subid=123&virtual_currency=0.50&sig=abcdef...&lead_id=xyz
router.get('/cpalead', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { subid, virtual_currency, ip, sig, lead_id } = req.query;
    if (!subid || !virtual_currency || !sig) {
      throw new AppError('Missing required parameters', 400);
    }

    const userId = parseInt(subid as string, 10);
    const amount = parseFloat(virtual_currency as string);

    // Fetch CPALEAD ad provider config
    const providerResult = await query('SELECT keys_config, is_active FROM ad_providers WHERE provider_key = $1', ['CPALEAD']);
    if (!providerResult.rowCount || !providerResult.rows[0].is_active) {
      throw new AppError('CPAlead ad provider is inactive or not configured', 400);
    }

    const config = providerResult.rows[0].keys_config;
    const secretKey = config.secret_key || 'cpalead_secret_key_default';

    // Verify signature (e.g. SHA256 of subid + ':' + secretKey)
    const dataToSign = `${subid}:${secretKey}`;
    const expectedSig = crypto.createHash('sha256').update(dataToSign).digest('hex');
    const expectedSigSha1 = crypto.createHash('sha1').update(dataToSign).digest('hex');

    if (sig !== expectedSig && sig !== expectedSigSha1) {
      throw new AppError('Invalid webhook signature', 403);
    }

    // Determine unique transaction ID
    const transactionId = (lead_id as string) || (sig as string);

    // Process reward
    await processS2SReward(userId, 'CPALEAD', amount, req.ip || (ip as string), transactionId, sig as string);

    res.status(200).send('1'); // CPAlead expects '1' for success
  } catch (error) {
    next(error);
  }
});

// Unity Ads webhook signature verification:
// GET /ads/webhooks/unity?sid=123&product=item&sig=abcdef...&oid=order123
router.get('/unity', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sid, product, sig, oid } = req.query;
    const unitySignature = req.headers['x-unity-signature'] || sig;

    if (!sid || !unitySignature) {
      throw new AppError('Missing required parameters', 400);
    }

    const userId = parseInt(sid as string, 10);

    const providerResult = await query('SELECT keys_config, is_active FROM ad_providers WHERE provider_key = $1', ['UNITY_ADS']);
    if (!providerResult.rowCount || !providerResult.rows[0].is_active) {
      throw new AppError('Unity Ads provider is inactive or not configured', 400);
    }

    const config = providerResult.rows[0].keys_config;
    const secretKey = config.secret_key || 'unity_secret_key_default';

    // Verify signature: HMAC-SHA256 of the raw query string (excluding signature itself if in query)
    const urlParts = req.url.split('?');
    let queryString = urlParts[1] || '';
    
    if (req.query.sig) {
      const params = new URLSearchParams(queryString);
      params.delete('sig');
      queryString = params.toString();
    }

    const hmac = crypto.createHmac('sha256', secretKey);
    const expectedSig = hmac.update(queryString).digest('hex');

    if (unitySignature !== expectedSig) {
      throw new AppError('Invalid webhook signature', 403);
    }

    const amount = req.query.amount ? parseFloat(req.query.amount as string) : 0.50;
    const transactionId = (oid as string) || (unitySignature as string);

    await processS2SReward(userId, 'UNITY_ADS', amount, req.ip || '', transactionId, unitySignature as string);

    res.status(200).send('OK');
  } catch (error) {
    next(error);
  }
});

// AppLovin webhook signature verification:
// GET /ads/webhooks/applovin?user_id=123&amount=0.50&sig=abcdef...&event_id=evt123
router.get('/applovin', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { user_id, amount, event_id, sig } = req.query;
    if (!user_id || !amount || !sig) {
      throw new AppError('Missing required parameters', 400);
    }

    const userId = parseInt(user_id as string, 10);
    const rewardAmount = parseFloat(amount as string);

    const providerResult = await query('SELECT keys_config, is_active FROM ad_providers WHERE provider_key = $1', ['APPLOVIN']);
    if (!providerResult.rowCount || !providerResult.rows[0].is_active) {
      throw new AppError('AppLovin provider is inactive or not configured', 400);
    }

    const config = providerResult.rows[0].keys_config;
    const secretKey = config.secret_key || 'applovin_secret_key_default';

    // Verify signature: SHA256 of user_id + amount + event_id + secretKey
    const dataToSign = `${user_id}:${amount}:${event_id || ''}:${secretKey}`;
    const expectedSig = crypto.createHash('sha256').update(dataToSign).digest('hex');

    if (sig !== expectedSig) {
      throw new AppError('Invalid webhook signature', 403);
    }

    const transactionId = (event_id as string) || (sig as string);

    await processS2SReward(userId, 'APPLOVIN', rewardAmount, req.ip || '', transactionId, sig as string);

    res.status(200).json({ status: 'success' });
  } catch (error) {
    next(error);
  }
});

export default router;
