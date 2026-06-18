import { pool, query } from '../config/db';
import { AppError } from '../middlewares/error';
import { WalletService } from './wallet.service';
import { LockService } from './lock.service';

export class DailyTasksService {
  static async getDailyTasksStatus(userId: number) {
    const todayStr = new Date().toISOString().split('T')[0];

    // Ensure a task status row exists for today
    await query(
      `INSERT INTO user_daily_tasks (user_id, task_date)
       VALUES ($1, $2)
       ON CONFLICT (user_id, task_date) DO NOTHING`,
      [userId, todayStr]
    );

    const statusResult = await query(
      `SELECT check_in_claimed, banner_clicks_count, share_app_claimed
       FROM user_daily_tasks
       WHERE user_id = $1 AND task_date = $2`,
      [userId, todayStr]
    );

    // Get today's referral registrations count
    const referralResult = await query(
      `SELECT COUNT(*) as count 
       FROM referrals
       WHERE referrer_id = $1 AND DATE(created_at) = $2`,
      [userId, todayStr]
    );

    const taskStatus = statusResult.rows[0];
    const referralCount = parseInt(referralResult.rows[0].count, 10);

    return {
      check_in_claimed: taskStatus.check_in_claimed,
      banner_clicks_count: taskStatus.banner_clicks_count,
      share_app_claimed: taskStatus.share_app_claimed || false,
      referral_clicks_count: referralCount,
    };
  }

  static async claimCheckIn(userId: number) {
    const todayStr = new Date().toISOString().split('T')[0];
    const lockKey = `daily_task_lock_${userId}`;
    const acquiredLock = await LockService.acquire(lockKey);
    if (!acquiredLock) {
      throw new AppError('Another daily task action is in progress.', 429);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock task status row
      const taskResult = await client.query(
        `SELECT check_in_claimed FROM user_daily_tasks 
         WHERE user_id = $1 AND task_date = $2 FOR UPDATE`,
        [userId, todayStr]
      );

      let checkInClaimed = false;
      if (taskResult.rowCount && taskResult.rowCount > 0) {
        checkInClaimed = taskResult.rows[0].check_in_claimed;
      } else {
        await client.query(
          `INSERT INTO user_daily_tasks (user_id, task_date) VALUES ($1, $2)`,
          [userId, todayStr]
        );
      }

      if (checkInClaimed) {
        throw new AppError('You have already claimed your daily check-in reward today.', 400);
      }

      // Mark as claimed
      await client.query(
        `UPDATE user_daily_tasks SET check_in_claimed = TRUE
         WHERE user_id = $1 AND task_date = $2`,
        [userId, todayStr]
      );

      // Get config check-in reward amount from DB
      const configRes = await client.query(
        'SELECT daily_checkin_reward FROM system_config WHERE id = 1'
      );
      const baseCheckinMicro = BigInt(configRes.rows[0]?.daily_checkin_reward || '100000'); // Default 0.10 Coinz if not set
      
      // Lock user row
      const userRes = await client.query(
        'SELECT available_balance, pending_balance, total_earned, vip_tier FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      const user = userRes.rows[0];
      const vipTier = user.vip_tier || 'FREE';
      const multiplier = await WalletService.getVipMultiplier(vipTier);

      // Apply VIP multiplier to reward amount
      const multiplierFactor = BigInt(Math.round((1 + multiplier) * 10000));
      let rewardMicro = (baseCheckinMicro * multiplierFactor) / 10000n;

      // Verify & enforce VIP daily earning cap
      rewardMicro = await WalletService.checkAndUpdateDailyEarningCap(
        client,
        userId,
        rewardMicro,
        vipTier
      );
      const finalAmountUsd = Number(rewardMicro) / 1000000.0;

      const currentAv = BigInt(user.available_balance || 0);
      const currentTe = BigInt(user.total_earned || 0);

      // Credit available balance (confirmed)
      await WalletService.logAndGetWalletUpdate(
        client,
        userId,
        'DAILY_CHECK_IN',
        finalAmountUsd,
        { available_balance: currentAv + rewardMicro, total_earned: currentTe + rewardMicro },
        `Daily check-in reward (Capped: $${finalAmountUsd})`
      );

      // Insert ledger record (with standardized type DAILY_CHECKIN)
      await client.query(
        `INSERT INTO ledger (user_id, type, amount, status)
         VALUES ($1, 'DAILY_CHECKIN', $2, 'CONFIRMED')`,
        [userId, rewardMicro.toString()]
      );

      await client.query('COMMIT');
      return { success: true, reward_coins: finalAmountUsd, reward_usd: finalAmountUsd };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      LockService.release(lockKey);
    }
  }

  static async claimBannerClick(userId: number) {
    const todayStr = new Date().toISOString().split('T')[0];
    const lockKey = `daily_task_lock_${userId}`;
    const acquiredLock = await LockService.acquire(lockKey);
    if (!acquiredLock) {
      throw new AppError('Another daily task action is in progress.', 429);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock task status row
      const taskResult = await client.query(
        `SELECT banner_clicks_count FROM user_daily_tasks 
         WHERE user_id = $1 AND task_date = $2 FOR UPDATE`,
        [userId, todayStr]
      );

      let clicksCount = 0;
      if (taskResult.rowCount && taskResult.rowCount > 0) {
        clicksCount = taskResult.rows[0].banner_clicks_count;
      } else {
        await client.query(
          `INSERT INTO user_daily_tasks (user_id, task_date) VALUES ($1, $2)`,
          [userId, todayStr]
        );
      }

      if (clicksCount >= 3) {
        throw new AppError('You have reached the maximum of 3 banner ad click rewards today.', 400);
      }

      // Increment clicks count
      await client.query(
        `UPDATE user_daily_tasks SET banner_clicks_count = banner_clicks_count + 1
         WHERE user_id = $1 AND task_date = $2`,
        [userId, todayStr]
      );

      // Get config banner click reward amount from DB
      const configRes = await client.query(
        'SELECT banner_click_reward FROM system_config WHERE id = 1'
      );
      const baseClickMicro = BigInt(configRes.rows[0]?.banner_click_reward || '200000'); // Default 0.20 Coinz if not set

      // Lock user row
      const userRes = await client.query(
        'SELECT available_balance, pending_balance, total_earned, vip_tier FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      const user = userRes.rows[0];
      const vipTier = user.vip_tier || 'FREE';
      const multiplier = await WalletService.getVipMultiplier(vipTier);

      // Apply VIP multiplier to reward amount
      const multiplierFactor = BigInt(Math.round((1 + multiplier) * 10000));
      let rewardMicro = (baseClickMicro * multiplierFactor) / 10000n;

      // Verify & enforce VIP daily earning cap
      rewardMicro = await WalletService.checkAndUpdateDailyEarningCap(
        client,
        userId,
        rewardMicro,
        vipTier
      );
      const finalAmountUsd = Number(rewardMicro) / 1000000.0;

      const currentAv = BigInt(user.available_balance || 0);
      const currentTe = BigInt(user.total_earned || 0);

      // Credit available balance (confirmed)
      await WalletService.logAndGetWalletUpdate(
        client,
        userId,
        'BANNER_CLICK',
        finalAmountUsd,
        { available_balance: currentAv + rewardMicro, total_earned: currentTe + rewardMicro },
        `Banner ad click reward #${clicksCount + 1}`
      );

      // Insert ledger record (with standardized type AD_REWARD)
      await client.query(
        `INSERT INTO ledger (user_id, type, amount, status)
         VALUES ($1, 'AD_REWARD', $2, 'CONFIRMED')`,
        [userId, rewardMicro.toString()]
      );

      await client.query('COMMIT');
      return { success: true, reward_coins: finalAmountUsd, reward_usd: finalAmountUsd, banner_clicks_count: clicksCount + 1 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      LockService.release(lockKey);
    }
  }

  static async claimShareApp(userId: number) {
    const todayStr = new Date().toISOString().split('T')[0];
    const lockKey = `daily_task_lock_${userId}`;
    const acquiredLock = await LockService.acquire(lockKey);
    if (!acquiredLock) {
      throw new AppError('Another daily task action is in progress.', 429);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock task status row
      const taskResult = await client.query(
        `SELECT share_app_claimed FROM user_daily_tasks 
         WHERE user_id = $1 AND task_date = $2 FOR UPDATE`,
        [userId, todayStr]
      );

      let shareAppClaimed = false;
      if (taskResult.rowCount && taskResult.rowCount > 0) {
        shareAppClaimed = taskResult.rows[0].share_app_claimed;
      } else {
        await client.query(
          `INSERT INTO user_daily_tasks (user_id, task_date) VALUES ($1, $2)`,
          [userId, todayStr]
        );
      }

      if (shareAppClaimed) {
        throw new AppError('You have already claimed your daily share app link reward today.', 400);
      }

      // Mark as claimed
      await client.query(
        `UPDATE user_daily_tasks SET share_app_claimed = TRUE
         WHERE user_id = $1 AND task_date = $2`,
        [userId, todayStr]
      );

      // Get config reward amount from DB
      const configRes = await client.query(
        'SELECT share_app_reward FROM system_config WHERE id = 1'
      );
      const baseShareMicro = BigInt(configRes.rows[0]?.share_app_reward || '5000000'); // Default 5.00 Coinz (5,000,000 micro-units)

      // Lock user row
      const userRes = await client.query(
        'SELECT available_balance, pending_balance, total_earned, vip_tier FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      const user = userRes.rows[0];
      const vipTier = user.vip_tier || 'FREE';
      const multiplier = await WalletService.getVipMultiplier(vipTier);

      // Apply VIP multiplier to reward amount
      const multiplierFactor = BigInt(Math.round((1 + multiplier) * 10000));
      let rewardMicro = (baseShareMicro * multiplierFactor) / 10000n;

      // Verify & enforce VIP daily earning cap
      rewardMicro = await WalletService.checkAndUpdateDailyEarningCap(
        client,
        userId,
        rewardMicro,
        vipTier
      );
      const finalAmountUsd = Number(rewardMicro) / 1000000.0;

      const currentAv = BigInt(user.available_balance || 0);
      const currentTe = BigInt(user.total_earned || 0);

      // Credit available balance (confirmed)
      await WalletService.logAndGetWalletUpdate(
        client,
        userId,
        'DAILY_SHARE_APP',
        finalAmountUsd,
        { available_balance: currentAv + rewardMicro, total_earned: currentTe + rewardMicro },
        `Daily share app reward (Capped: $${finalAmountUsd})`
      );

      // Insert ledger record
      await client.query(
        `INSERT INTO ledger (user_id, type, amount, status)
         VALUES ($1, 'DAILY_SHARE_APP', $2, 'CONFIRMED')`,
        [userId, rewardMicro.toString()]
      );

      await client.query('COMMIT');
      return { success: true, reward_coins: finalAmountUsd, reward_usd: finalAmountUsd };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      LockService.release(lockKey);
    }
  }
}
