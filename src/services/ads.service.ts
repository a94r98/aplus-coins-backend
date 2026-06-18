import { pool, query } from '../config/db';
import { env } from '../config/env';
import { AppError } from '../middlewares/error';
import { ReferralService } from './referral.service';
import { HardeningService } from './hardening.service';
import { SafetyService } from './safety.service';
import { WalletService } from './wallet.service';
import { LockService } from './lock.service';
import crypto from 'crypto';

export class AdsService {
  static async getAdLimits(vipTier: string) {
    const { ConfigService } = require('./config.service');
    const config = await ConfigService.getVipTierConfig(vipTier);
    const sysConfig = await ConfigService.getSystemConfig();

    // Generate a random base reward between ad_reward_min and ad_reward_max
    const minRewardMicro = BigInt(sysConfig.ad_reward_min);
    const maxRewardMicro = BigInt(sysConfig.ad_reward_max);

    let rewardMicro = minRewardMicro;
    if (maxRewardMicro > minRewardMicro) {
      const range = Number(maxRewardMicro - minRewardMicro);
      const randomOffset = Math.floor(Math.random() * (range + 1));
      rewardMicro = minRewardMicro + BigInt(randomOffset);
    }

    const baseRewardLogical = Number(rewardMicro) / 1000000.0;

    return {
      limit: config.daily_ad_limit,
      reward: baseRewardLogical,
    };
  }

  static async watchAd(
    userId: number,
    adId: string,
    options?: { requestHash?: string; deviceFingerprint?: string; clientTimestamp?: number; ip?: string }
  ) {
    // Dynamically import QueueService to prevent circular dependency
    const { QueueService } = require('./queue.service');
    return QueueService.enqueue('AD_VALIDATION', { userId, adId, options });
  }

  static async watchAdInternal(
    userId: number,
    adId: string,
    options?: { requestHash?: string; deviceFingerprint?: string; clientTimestamp?: number; ip?: string }
  ) {
    // Check if ads are enabled in system_config
    const systemConfigResult = await query(
      'SELECT ads_enabled FROM system_config WHERE id = 1'
    );
    let adsEnabled = true;
    if (systemConfigResult.rowCount && systemConfigResult.rowCount > 0) {
      adsEnabled = systemConfigResult.rows[0].ads_enabled;
    }
    if (!adsEnabled) {
      throw new AppError('Ads are currently disabled', 400);
    }

    const todayStr = new Date().toISOString().split('T')[0];
    
    // Check if daily rewards are settled/locked
    const isSettled = await HardeningService.isDateSettled(todayStr);
    if (isSettled) {
      throw new AppError(`Reward generation for date ${todayStr} has been finalized and locked.`, 403);
    }

    const lockKey = `ad_lock_${userId}`;
    const acquiredLock = await LockService.acquire(lockKey);
    if (!acquiredLock) {
      throw new AppError('Another ad watch transaction is currently processing for your account. Please try again.', 429);
    }

    const client = await pool.connect();
    let estimatedReward = 0.10;
    let acquired = false;
    let success = false;

    try {
      await client.query('BEGIN');

      // 1. Lock user row immediately for strict database transactions and consistency
      const userResult = await client.query(
        'SELECT id, vip_tier, balance, pending_balance, available_balance, is_suspicious FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (!userResult.rowCount) {
        throw new AppError('User not found', 404);
      }
      const user = userResult.rows[0];

      // Server timestamp validation
      if (!options?.clientTimestamp) {
        throw new AppError('Client timestamp is required.', 400);
      }
      const serverTime = Date.now();
      const timeDiff = Math.abs(serverTime - options.clientTimestamp);
      if (timeDiff > 300000) {
        throw new AppError('Server and client clocks are out of sync (exceeded 5 mins drift limit).', 400);
      }

      // 2. Cooldown check inside transaction: Must be at least 30s since the last ad watch
      const lastAdResult = await client.query(
        'SELECT watched_at FROM ad_logs WHERE user_id = $1 ORDER BY watched_at DESC LIMIT 1 FOR UPDATE',
        [userId]
      );

      if (lastAdResult.rowCount && lastAdResult.rowCount > 0) {
        const lastWatched = new Date(lastAdResult.rows[0].watched_at).getTime();
        const now = Date.now();
        const elapsedSeconds = (now - lastWatched) / 1000;
        if (elapsedSeconds < env.COOLDOWN_SECONDS) {
          const waitTime = Math.ceil(env.COOLDOWN_SECONDS - elapsedSeconds);
          await client.query('UPDATE users SET is_suspicious = TRUE WHERE id = $1', [userId]);
          throw new AppError(`Ad cooldown active. Please wait ${waitTime} more seconds.`, 429);
        }
      }

      // 3. Daily limit check inside transaction
      const dailyCountResult = await client.query(
        `SELECT COUNT(*) as count FROM ad_logs 
         WHERE user_id = $1 AND watched_date = $2`,
        [userId, todayStr]
      );
      const todayAdCount = parseInt(dailyCountResult.rows[0].count, 10);

      const { limit: dailyLimit, reward: baseReward } = await this.getAdLimits(user.vip_tier);

      if (todayAdCount >= dailyLimit) {
        throw new AppError(`Daily limit of ${dailyLimit} ads reached for your tier (${user.vip_tier}). Upgrade to watch more.`, 403);
      }

      // Calculate dynamic reward based on system state
      const state = await HardeningService.getSystemState();

      let reward = baseReward;
      if (state === 'LIMITED_MODE') {
        reward = baseReward * 0.5;
      } else if (state === 'BALANCE_MODE') {
        reward = baseReward * 0.8;
      }

      // Apply VIP profit multiplier on top of base reward
      const vipMultiplier = await WalletService.getVipMultiplier(user.vip_tier || 'FREE');
      reward = reward * (1 + vipMultiplier);

      estimatedReward = reward;

      // 4. Global Payout Semaphore Check before proceeding
      acquired = await SafetyService.checkAndAcquirePayout(estimatedReward);
      if (!acquired) {
        // Downgrade to LIMITED_MODE reward structure instantly
        reward = baseReward * 0.5 * (1 + vipMultiplier);
        estimatedReward = reward;
        acquired = await SafetyService.checkAndAcquirePayout(estimatedReward);
        if (!acquired) {
          throw new AppError('Daily payout pool limit reached. Ad watching is temporarily disabled.', 403);
        }
      }

      const requestHash = options?.requestHash || crypto.createHash('sha256').update(`${userId}_${adId}_${Date.now()}`).digest('hex');
      const fingerprint = options?.deviceFingerprint || '';
      const clientIp = options?.ip || '';

      const isSuspicious = user.is_suspicious || await this.checkFraudAndFlagInternal(client, userId, adId, clientIp, fingerprint);

      try {
        await client.query(
          `INSERT INTO ad_logs (user_id, ad_id, reward_amount, request_hash, device_fingerprint, is_suspicious, watched_date) 
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [userId, adId, reward, requestHash, fingerprint, isSuspicious, todayStr]
        );
      } catch (err: any) {
        if (err.code === '23505') {
          await client.query('UPDATE users SET is_suspicious = TRUE WHERE id = $1', [userId]);
          throw new AppError('This ad has already been watched or double submission detected.', 400);
        }
        throw err;
      }

      if (fingerprint) {
        await client.query('UPDATE users SET device_fingerprint = $1 WHERE id = $2', [fingerprint, userId]);
      }

      // Increment ads_watched inside daily_control
      await client.query(
        `INSERT INTO daily_control (user_id, date, ads_watched)
         VALUES ($1, $2, 1)
         ON CONFLICT (user_id, date) DO UPDATE
         SET ads_watched = daily_control.ads_watched + 1`,
        [userId, todayStr]
      );

      // Verify & enforce VIP daily earning cap
      const baseRewardMicro = BigInt(Math.round(reward * 1000000));
      const rewardMicro = await WalletService.checkAndUpdateDailyEarningCap(
        client,
        userId,
        baseRewardMicro,
        user.vip_tier || 'FREE'
      );
      const finalReward = Number(rewardMicro) / 1000000.0;

      // Update balance using WalletService.logAndGetWalletUpdate helper
      const currentPb = BigInt(user.pending_balance || 0);
      await WalletService.logAndGetWalletUpdate(
        client,
        userId,
        'AD_REWARD',
        finalReward,
        { pending_balance: currentPb + rewardMicro },
        `Watched ad: ${adId}`
      );

      // Insert ledger entry (with standardized type AD_REWARD)
      await client.query(
        `INSERT INTO ledger (user_id, type, amount, status)
         VALUES ($1, 'AD_REWARD', $2, 'CONFIRMED')`,
        [userId, rewardMicro.toString()]
      );

      await ReferralService.processAdWatchCommission(client, userId, finalReward);

      await client.query('COMMIT');
      success = true;

      const userBalanceResult = await client.query(
        'SELECT balance, pending_balance, available_balance FROM users WHERE id = $1',
        [userId]
      );
      const updatedUser = userBalanceResult.rows[0];

      return {
        success: true,
        reward_amount: reward,
        pending_balance: (Number(updatedUser.pending_balance) / 1000000),
        available_balance: (Number(updatedUser.available_balance) / 1000000),
        ads_watched_today: todayAdCount + 1,
        remaining_ads_today: dailyLimit - (todayAdCount + 1),
        status: 'PENDING_AUDIT',
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      if (acquired) {
        SafetyService.releasePayout(estimatedReward, success);
      }
      LockService.release(lockKey);
    }
  }

  private static async checkFraudAndFlagInternal(client: any, userId: number, adId: string, clientIp: string, deviceFingerprint?: string): Promise<boolean> {
    if (deviceFingerprint) {
      const multiUserResult = await client.query(
        "SELECT COUNT(DISTINCT id) as count FROM users WHERE device_fingerprint = $1 AND id != $2",
        [deviceFingerprint, userId]
      );
      const otherUsersCount = parseInt(multiUserResult.rows[0].count, 10);
      if (otherUsersCount >= 2) {
        await client.query("UPDATE users SET is_suspicious = TRUE WHERE id = $1", [userId]);
        return true;
      }
    }

    const lastAdResult = await client.query(
      'SELECT watched_at FROM ad_logs WHERE user_id = $1 ORDER BY watched_at DESC LIMIT 1',
      [userId]
    );
    if (lastAdResult.rowCount && lastAdResult.rowCount > 0) {
      const lastWatched = new Date(lastAdResult.rows[0].watched_at).getTime();
      const diff = (Date.now() - lastWatched) / 1000;
      if (diff < 28) {
        await client.query("UPDATE users SET is_suspicious = TRUE WHERE id = $1", [userId]);
        return true;
      }
    }

    const repeatedAdResult = await client.query(
      'SELECT COUNT(*) as count FROM ad_logs WHERE user_id = $1 AND ad_id = $2 AND watched_date = CURRENT_DATE',
      [userId, adId]
    );
    const count = parseInt(repeatedAdResult.rows[0].count, 10);
    if (count > 0) {
      return true;
    }

    return false;
  }

  static async getHistory(userId: number, limit = 50) {
    const result = await query(
      'SELECT id, ad_id, reward_amount, watched_at, is_suspicious FROM ad_logs WHERE user_id = $1 ORDER BY watched_at DESC LIMIT $2',
      [userId, limit]
    );
    return result.rows;
  }

  static async getActiveBanners() {
    const result = await query(
      `SELECT id, title, description, image_url, action_url, reward_amount, ad_type 
       FROM advertisements 
       WHERE is_active = TRUE AND ad_type = 'BANNER' 
       ORDER BY id DESC`
    );
    return result.rows;
  }
}
