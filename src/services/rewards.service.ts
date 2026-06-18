import { pool, query } from '../config/db';
import { AppError } from '../middlewares/error';
import { HardeningService } from './hardening.service';
import { SafetyService } from './safety.service';
import { WalletService } from './wallet.service';
import { LockService } from './lock.service';

export class RewardsService {
  static async createAndDistributePool(totalRevenue: number) {
    const { QueueService } = require('./queue.service');
    return QueueService.enqueue('SHARE_CALCULATION', { totalRevenue });
  }

  static async createAndDistributePoolInternal(totalRevenue: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const dateStr = new Date().toISOString().split('T')[0];

      // Check if pool for today already exists
      const existingPool = await client.query(
        'SELECT id FROM reward_pool WHERE pool_date = $1',
        [dateStr]
      );

      if (existingPool.rowCount && existingPool.rowCount > 0) {
        throw new AppError('Reward pool for today has already been created and distributed.', 400);
      }

      const state = await HardeningService.getSystemState();
      let poolShareMultiplier = 0.50;
      if (state === 'LIMITED_MODE') {
        poolShareMultiplier = 0.25;
      } else if (state === 'BALANCE_MODE') {
        poolShareMultiplier = 0.40;
      }

      const poolShare = totalRevenue * poolShareMultiplier;
      const referralShare = totalRevenue * 0.15;
      const platformShare = totalRevenue - poolShare - referralShare;

      // Insert pool details
      const poolResult = await client.query(
        `INSERT INTO reward_pool (pool_date, total_revenue, pool_share_split, referral_split, platform_split, is_distributed)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id`,
        [dateStr, totalRevenue, poolShare, referralShare, platformShare]
      );

      // Find all active VIP users (VIP1, VIP2, VIP3) from active subscriptions, ordered to prevent deadlocks
      const activeVipsResult = await client.query(
        `SELECT DISTINCT user_id FROM subscriptions
         WHERE status = 'ACTIVE' AND expires_at > NOW()
         ORDER BY user_id ASC`
      );

      const vipCount = activeVipsResult.rowCount || 0;
      const sharesCreated: { userId: number; shareAmount: number }[] = [];

      if (vipCount > 0) {
        const sharePerVip = poolShare / vipCount;
        const sharePerVipMicro = BigInt(Math.round(sharePerVip * 1000000));

        for (const row of activeVipsResult.rows) {
          const userId = row.user_id;

          // Lock user row first
          const userRes = await client.query(
            'SELECT available_balance, pending_balance, total_earned, total_withdrawn FROM users WHERE id = $1 FOR UPDATE',
            [userId]
          );

          if (userRes.rowCount) {
            const currentAv = BigInt(userRes.rows[0].available_balance || 0);
            const currentTe = BigInt(userRes.rows[0].total_earned || 0);

            // Insert daily_shares as already claimed (statistics and ledger transparency)
            await client.query(
              `INSERT INTO daily_shares (user_id, share_date, pool_share_amount, is_claimed, claimed_at)
               VALUES ($1, $2, $3, TRUE, NOW())
               ON CONFLICT (user_id, share_date) DO UPDATE 
               SET pool_share_amount = EXCLUDED.pool_share_amount, is_claimed = TRUE, claimed_at = NOW()`,
              [userId, dateStr, sharePerVip]
            );

            // Insert confirmed ledger record
            await client.query(
              `INSERT INTO ledger (user_id, type, amount, status)
               VALUES ($1, 'REWARD', $2, 'CONFIRMED')`,
              [userId, sharePerVipMicro.toString()]
            );

            // Credit directly to user's available balance (confirmed) and create audit log
            await WalletService.logAndGetWalletUpdate(
              client,
              userId,
              'DAILY_SHARE_DISTRIBUTION',
              sharePerVip,
              { available_balance: currentAv + sharePerVipMicro, total_earned: currentTe + sharePerVipMicro },
              `Daily VIP share split for date ${dateStr}`
            );

            // Explicitly update user_balance_cache inside transaction
            await client.query(
              `INSERT INTO user_balance_cache (user_id, balance, updated_at)
               VALUES ($1, $2, CURRENT_TIMESTAMP)
               ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = CURRENT_TIMESTAMP`,
              [userId, (currentAv + sharePerVipMicro).toString()]
            );

            // Update daily control statistics
            await client.query(
              `INSERT INTO daily_control (user_id, date, shares_earned)
               VALUES ($1, $2, $3)
               ON CONFLICT (user_id, date) DO UPDATE
               SET shares_earned = daily_control.shares_earned + EXCLUDED.shares_earned`,
              [userId, dateStr, sharePerVip]
            );

            sharesCreated.push({ userId, shareAmount: sharePerVip });
          }
        }
      }

      // Settle and lock this date once calculations are finalized, freezing any further reward generation
      await HardeningService.settleDate(dateStr);

      await client.query('COMMIT');
      return {
        poolId: poolResult.rows[0].id,
        date: dateStr,
        totalRevenue,
        poolShare,
        referralShare,
        platformShare,
        vipsCount: vipCount,
        sharesCount: sharesCreated.length,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getUnclaimedShares(userId: number) {
    const result = await query(
      `SELECT id, share_date, pool_share_amount, is_claimed 
       FROM daily_shares 
       WHERE user_id = $1 AND is_claimed = FALSE 
       ORDER BY share_date DESC`,
      [userId]
    );
    return result.rows;
  }

  static async claimDailyShare(userId: number, shareId: number) {
    const { QueueService } = require('./queue.service');
    return QueueService.enqueue('WALLET_UPDATE', { action: 'CLAIM_DAILY_SHARE', userId, shareId });
  }

  static async claimDailyShareInternal(userId: number, shareId: number) {
    const todayStr = new Date().toISOString().split('T')[0];
    const isSettled = await HardeningService.isDateSettled(todayStr);
    if (isSettled) {
      throw new AppError(`Reward generation for date ${todayStr} has been finalized and locked.`, 403);
    }

    const lockKey = `wallet_lock_${userId}`;
    const acquiredLock = await LockService.acquire(lockKey);
    if (!acquiredLock) {
      throw new AppError('Another transaction is processing on your wallet. Please try again.', 429);
    }

    const client = await pool.connect();
    let claimAmount = 0;
    let acquired = false;
    let success = false;

    try {
      await client.query('BEGIN');

      // 1. Lock user row first for strict transactions
      const userLockResult = await client.query(
        'SELECT id, pending_balance FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (!userLockResult.rowCount) {
        throw new AppError('User not found.', 404);
      }

      const user = userLockResult.rows[0];

      const shareResult = await client.query(
        'SELECT id, pool_share_amount, is_claimed FROM daily_shares WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [shareId, userId]
      );

      if (!shareResult.rowCount) {
        throw new AppError('Daily share not found or not assigned to you.', 404);
      }

      const share = shareResult.rows[0];
      if (share.is_claimed) {
        throw new AppError('This daily share has already been claimed.', 400);
      }

      claimAmount = parseFloat(share.pool_share_amount);

      // Check and acquire payout in semaphore
      acquired = await SafetyService.checkAndAcquirePayout(claimAmount);
      if (!acquired) {
        throw new AppError('Daily payout pool limit reached. Share claiming is temporarily disabled.', 403);
      }

      // Mark share as claimed
      await client.query(
        'UPDATE daily_shares SET is_claimed = TRUE, claimed_at = NOW() WHERE id = $1',
        [shareId]
      );

      const claimAmountMicro = BigInt(Math.round(claimAmount * 1000000));
      const currentPb = BigInt(user.pending_balance || 0);

      // Credit directly to pending balance and log audit
      await WalletService.logAndGetWalletUpdate(
        client,
        userId,
        'CLAIM_DAILY_SHARE',
        claimAmount,
        { pending_balance: currentPb + claimAmountMicro },
        `Claimed daily share ID ${shareId}`
      );

      await client.query(
        `INSERT INTO daily_control (user_id, date, shares_earned)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, date) DO UPDATE
         SET shares_earned = daily_control.shares_earned + EXCLUDED.shares_earned`,
        [userId, todayStr, claimAmount]
      );

      await client.query('COMMIT');
      success = true;

      const balanceResult = await client.query(
        'SELECT balance, pending_balance, available_balance FROM users WHERE id = $1',
        [userId]
      );
      const userBal = balanceResult.rows[0];

      return {
        success: true,
        claimed_amount: claimAmount,
        new_balance: parseFloat(userBal.balance),
        pending_balance: Number(userBal.pending_balance) / 1000000,
        available_balance: Number(userBal.available_balance) / 1000000,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      if (acquired) {
        SafetyService.releasePayout(claimAmount, success);
      }
      LockService.release(lockKey);
    }
  }
}
