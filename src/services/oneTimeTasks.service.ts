import { pool, query } from '../config/db';
import { AppError } from '../middlewares/error';
import { WalletService } from './wallet.service';
import { LockService } from './lock.service';

export class OneTimeTasksService {
  static async getOneTimeTasks(userId: number) {
    const res = await query(
      `SELECT t.task_key, t.title, t.arabic_title, t.url, t.reward_amount, t.max_reward_claims, t.cooldown_seconds,
              (ut.id IS NOT NULL) as is_completed
       FROM one_time_tasks t
       LEFT JOIN user_one_time_tasks ut ON t.task_key = ut.task_key AND ut.user_id = $1
       WHERE t.is_active = TRUE
       ORDER BY t.id ASC`,
      [userId]
    );

    return res.rows.map(row => ({
      task_key: row.task_key,
      title: row.title,
      arabic_title: row.arabic_title,
      url: row.url,
      reward_amount: parseFloat(row.reward_amount) / 1000000.0, // Logical Coinz float
      max_reward_claims: row.max_reward_claims,
      cooldown_seconds: row.cooldown_seconds,
      is_completed: !!row.is_completed,
    }));
  }

  static async claimOneTimeTask(
    userId: number,
    taskKey: string,
    deviceFingerprint: string,
    ipAddress: string
  ) {
    const lockKey = `wallet_lock_${userId}`;
    const acquiredLock = await LockService.acquire(lockKey);
    if (!acquiredLock) {
      throw new AppError('Another transaction is processing on your wallet. Please try again.', 429);
    }

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Fetch task info
        const taskRes = await client.query(
          `SELECT task_key, reward_amount, max_reward_claims, is_active 
           FROM one_time_tasks 
           WHERE task_key = $1 FOR UPDATE`,
          [taskKey]
        );

        if (!taskRes.rowCount) {
          throw new AppError('Social task not found.', 404);
        }

        const task = taskRes.rows[0];
        if (!task.is_active) {
          throw new AppError('This social task is currently inactive.', 400);
        }

        // Check if user already claimed
        const userClaimCheck = await client.query(
          `SELECT id FROM user_one_time_tasks 
           WHERE user_id = $1 AND task_key = $2 FOR UPDATE`,
          [userId, taskKey]
        );

        if (userClaimCheck.rowCount && userClaimCheck.rowCount > 0) {
          throw new AppError('You have already claimed the reward for this task.', 400);
        }

        // Check global budget cap
        if (task.max_reward_claims !== null) {
          const globalClaimsRes = await client.query(
            `SELECT COUNT(*) as count FROM user_one_time_tasks 
             WHERE task_key = $1`,
            [taskKey]
          );
          const totalClaims = parseInt(globalClaimsRes.rows[0].count, 10);
          if (totalClaims >= task.max_reward_claims) {
            throw new AppError('This task campaign has reached its maximum claims limit.', 400);
          }
        }

        // Enforce strict unique device fingerprint check (Block)
        if (deviceFingerprint) {
          const deviceCheck = await client.query(
            `SELECT id FROM user_one_time_tasks 
             WHERE task_key = $1 AND device_fingerprint = $2`,
            [taskKey, deviceFingerprint]
          );
          if (deviceCheck.rowCount && deviceCheck.rowCount > 0) {
            throw new AppError('This device has already been used to claim this task reward.', 403);
          }
        }

        // IP-based risk assessment (No block. Flag as suspicious if threshold crossed)
        if (ipAddress) {
          const todayStr = new Date().toISOString().split('T')[0];
          const ipCheck = await client.query(
            `SELECT COUNT(DISTINCT user_id) as count FROM user_one_time_tasks 
             WHERE task_key = $1 AND ip_address = $2 AND DATE(claimed_at) = $3`,
            [taskKey, ipAddress, todayStr]
          );
          const distinctUsersOnIp = parseInt(ipCheck.rows[0].count, 10);
          if (distinctUsersOnIp >= 3) {
            // Flag account for review
            await client.query(
              'UPDATE users SET is_suspicious = TRUE WHERE id = $1',
              [userId]
            );
          }
        }

        // Fetch user data
        const userResult = await client.query(
          'SELECT available_balance, total_earned, vip_tier FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );
        const user = userResult.rows[0];
        const vipTier = user.vip_tier || 'FREE';
        const multiplier = await WalletService.getVipMultiplier(vipTier);

        const baseRewardMicro = BigInt(task.reward_amount);
        
        // Apply VIP multiplier
        const multiplierFactor = BigInt(Math.round((1 + multiplier) * 10000));
        let rewardMicro = (baseRewardMicro * multiplierFactor) / 10000n;

        // Enforce daily earning cap
        rewardMicro = await WalletService.checkAndUpdateDailyEarningCap(
          client,
          userId,
          rewardMicro,
          vipTier
        );
        const finalReward = Number(rewardMicro) / 1000000.0;

        // Insert completion record
        await client.query(
          `INSERT INTO user_one_time_tasks (user_id, task_key, device_fingerprint, ip_address)
           VALUES ($1, $2, $3, $4)`,
          [userId, taskKey, deviceFingerprint || null, ipAddress || null]
        );

        // Update balance
        const currentAv = BigInt(user.available_balance || 0);
        const currentTe = BigInt(user.total_earned || 0);

        await WalletService.logAndGetWalletUpdate(
          client,
          userId,
          'SOCIAL_TASK',
          finalReward,
          { available_balance: currentAv + rewardMicro, total_earned: currentTe + rewardMicro },
          `Completed social task: ${taskKey}`
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
           VALUES ($1, 'SOCIAL_TASK', $2, 'CONFIRMED')`,
          [userId, rewardMicro.toString()]
        );

        await client.query('COMMIT');

        return {
          success: true,
          task_key: taskKey,
          reward_amount: finalReward,
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
