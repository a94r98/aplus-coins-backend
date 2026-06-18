import { pool, query } from '../config/db';
import { AppError } from '../middlewares/error';
import { WalletService } from './wallet.service';
import { LockService } from './lock.service';

export class VipService {
  static async getDailyRewardStatus(userId: number) {
    const subResult = await query(
      `SELECT id, tier, amount, starts_at, expires_at 
       FROM subscriptions 
       WHERE user_id = $1 AND status = 'ACTIVE' AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      [userId]
    );

    if (!subResult.rowCount) {
      return { hasActiveVip: false };
    }

    const sub = subResult.rows[0];
    const subId = sub.id;
    const amount = parseFloat(sub.amount);

    const { ConfigService } = require('./config.service');
    const sysConfig = await ConfigService.getSystemConfig();
    const claimDuration = sysConfig.vip_daily_claim_duration;
    const dailyRewardAmount = amount / claimDuration;

    const todayStr = new Date().toISOString().split('T')[0];
    const claimTodayResult = await query(
      `SELECT id FROM vip_daily_claims 
       WHERE user_id = $1 AND subscription_id = $2 AND claim_date = $3`,
      [userId, subId, todayStr]
    );
    const isClaimedToday = (claimTodayResult.rowCount && claimTodayResult.rowCount > 0) ? true : false;

    const claimsResult = await query(
      `SELECT claim_date FROM vip_daily_claims 
       WHERE subscription_id = $1 
       ORDER BY claim_date DESC`,
      [subId]
    );
    const claimedDates = claimsResult.rows.map(r => {
      // Format DATE type cleanly
      if (r.claim_date instanceof Date) {
        return r.claim_date.toISOString().split('T')[0];
      }
      return r.claim_date;
    });

    const daysRemaining = Math.max(
      0,
      Math.ceil((new Date(sub.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    );

    return {
      hasActiveVip: true,
      tier: sub.tier,
      subscriptionId: subId,
      expiresAt: sub.expires_at,
      startsAt: sub.starts_at,
      daysTotal: claimDuration,
      daysRemaining,
      dailyRewardAmount,
      isClaimedToday,
      claimedDates,
    };
  }

  static async claimDailyReward(userId: number) {
    const lockKey = `wallet_lock_${userId}`;
    const acquiredLock = await LockService.acquire(lockKey);
    if (!acquiredLock) {
      throw new AppError('Another transaction is processing on your wallet. Please try again.', 429);
    }

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Fetch user active subscription
        const subResult = await client.query(
          `SELECT id, tier, amount, starts_at, expires_at 
           FROM subscriptions 
           WHERE user_id = $1 AND status = 'ACTIVE' AND expires_at > NOW()
           ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [userId]
        );

        if (!subResult.rowCount) {
          throw new AppError('No active VIP subscription found.', 400);
        }

        const sub = subResult.rows[0];
        const subId = sub.id;
        const amount = parseFloat(sub.amount);
        const { ConfigService } = require('./config.service');
        const sysConfig = await ConfigService.getSystemConfig();
        const claimDuration = sysConfig.vip_daily_claim_duration;
        const rewardMicro = BigInt(Math.floor(amount * 1000000 / claimDuration));

        const todayStr = new Date().toISOString().split('T')[0];

        // Check unique calendar claim per subscription
        const claimTodayResult = await client.query(
          `SELECT id FROM vip_daily_claims 
           WHERE subscription_id = $1 AND claim_date = $2 FOR UPDATE`,
          [subId, todayStr]
        );

        if (claimTodayResult.rowCount && claimTodayResult.rowCount > 0) {
          throw new AppError('Daily VIP reward already claimed today.', 400);
        }

        // Insert claim record
        await client.query(
          `INSERT INTO vip_daily_claims (user_id, subscription_id, claim_date, amount)
           VALUES ($1, $2, $3, $4)`,
          [userId, subId, todayStr, rewardMicro.toString()]
        );

        // Fetch and lock user details
        const userResult = await client.query(
          'SELECT available_balance, total_earned FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );
        const user = userResult.rows[0];
        const currentAv = BigInt(user.available_balance || 0);
        const currentTe = BigInt(user.total_earned || 0);

        // Update balances
        const dailyRewardLogical = amount / claimDuration;
        await WalletService.logAndGetWalletUpdate(
          client,
          userId,
          'VIP_DAILY_REWARD',
          dailyRewardLogical,
          { available_balance: currentAv + rewardMicro, total_earned: currentTe + rewardMicro },
          `VIP Daily Reward claim for subscription ID ${subId}`
        );

        // Explicitly update user_balance_cache inside transaction
        await client.query(
          `INSERT INTO user_balance_cache (user_id, balance, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = CURRENT_TIMESTAMP`,
          [userId, (currentAv + rewardMicro).toString()]
        );

        // Record in unified ledger
        await client.query(
          `INSERT INTO ledger (user_id, type, amount, status)
           VALUES ($1, 'VIP_DAILY_REWARD', $2, 'CONFIRMED')`,
          [userId, rewardMicro.toString()]
        );

        await client.query('COMMIT');
        return {
          success: true,
          claimed_amount: dailyRewardLogical,
          new_balance: Number(currentAv + rewardMicro) / 1000000.0,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } finally {
      LockService.release(lockKey);
    }
  }
}
