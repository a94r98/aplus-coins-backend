import { pool, query } from '../config/db';
import { env } from '../config/env';
import { AppError } from '../middlewares/error';
import { LockService } from './lock.service';

export class WalletService {
  static async logAndGetWalletUpdate(
    client: any,
    userId: number,
    action: string,
    amountUsd: number,
    updates: {
      available_balance?: bigint;
      pending_balance?: bigint;
      total_earned?: bigint;
      total_withdrawn?: bigint;
    },
    details?: string
  ) {
    const userResult = await client.query(
      `SELECT available_balance, pending_balance, total_earned, total_withdrawn 
       FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    if (!userResult.rowCount) {
      throw new Error('User not found');
    }
    const current = userResult.rows[0];
    const beforeAv = BigInt(current.available_balance || 0);
    const beforePb = BigInt(current.pending_balance || 0);
    const beforeTe = BigInt(current.total_earned || 0);
    const beforeTw = BigInt(current.total_withdrawn || 0);

    const afterAv = updates.available_balance !== undefined ? updates.available_balance : beforeAv;
    const afterPb = updates.pending_balance !== undefined ? updates.pending_balance : beforePb;
    const afterTe = updates.total_earned !== undefined ? updates.total_earned : beforeTe;
    const afterTw = updates.total_withdrawn !== undefined ? updates.total_withdrawn : beforeTw;

    const balanceUsd = Number(afterAv) / 1000000;

    await client.query(
      `UPDATE users 
       SET available_balance = $1, 
           pending_balance = $2, 
           total_earned = $3, 
           total_withdrawn = $4,
           balance = $5
       WHERE id = $6`,
      [afterAv.toString(), afterPb.toString(), afterTe.toString(), afterTw.toString(), balanceUsd, userId]
    );

    await client.query(
      `INSERT INTO wallet_audit_logs (
        user_id, action, amount, 
        available_balance_before, available_balance_after,
        pending_balance_before, pending_balance_after,
        total_earned_before, total_earned_after,
        total_withdrawn_before, total_withdrawn_after,
        details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        userId, action, amountUsd,
        beforeAv.toString(), afterAv.toString(),
        beforePb.toString(), afterPb.toString(),
        beforeTe.toString(), afterTe.toString(),
        beforeTw.toString(), afterTw.toString(),
        details || ''
      ]
    );
  }

  static async getVipCost(tier: string): Promise<number> {
    const { ConfigService } = require('./config.service');
    const config = await ConfigService.getVipTierConfig(tier);
    return Number(config.price_usd) / 1000000.0;
  }

  static async upgradeVip(userId: number, tier: string) {
    const { QueueService } = require('./queue.service');
    return QueueService.enqueue('WALLET_UPDATE', { action: 'UPGRADE_VIP', userId, tier });
  }

  static async upgradeVipInternal(userId: number, tier: string) {
    const lockKey = `wallet_lock_${userId}`;
    const acquiredLock = await LockService.acquire(lockKey);
    if (!acquiredLock) {
      throw new AppError('Another transaction is processing on your wallet. Please try again.', 429);
    }

    try {
      const cost = await this.getVipCost(tier);
      const costMicro = BigInt(Math.round(cost * 1000000));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check user available balance with row lock
        const userResult = await client.query(
          'SELECT id, available_balance, vip_tier FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );
        if (!userResult.rowCount) {
          throw new AppError('User not found', 404);
        }

        const user = userResult.rows[0];
        const avMicro = BigInt(user.available_balance || 0);

        if (avMicro < costMicro) {
          const balanceUsd = Number(avMicro) / 1000000;
          throw new AppError(`Insufficient available balance. Upgrading to ${tier} costs $${cost}. Your available balance is $${balanceUsd}.`, 400);
        }

        // Deduct balance and update VIP tier using the helper
        await this.logAndGetWalletUpdate(
          client,
          userId,
          'VIP_UPGRADE',
          -cost,
          { available_balance: avMicro - costMicro },
          `Upgraded to ${tier}`
        );

        await client.query(
          'UPDATE users SET vip_tier = $1 WHERE id = $2',
          [tier, userId]
        );

        // Expiry set to 30 days from now
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);

        // Mark old active subscriptions as expired
        await client.query(
          "UPDATE subscriptions SET status = 'EXPIRED' WHERE user_id = $1 AND status = 'ACTIVE'",
          [userId]
        );

        // Insert new subscription record
        await client.query(
          `INSERT INTO subscriptions (user_id, tier, amount, expires_at, status)
           VALUES ($1, $2, $3, $4, 'ACTIVE')`,
          [userId, tier, cost, expiresAt]
        );

        await client.query('COMMIT');

        return {
          success: true,
          upgraded_to: tier,
          cost,
          new_balance: Number(avMicro - costMicro) / 1000000,
          expires_at: expiresAt,
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

  static async requestWithdrawal(userId: number, amount: number, walletAddress: string) {
    const { QueueService } = require('./queue.service');
    return QueueService.enqueue('WALLET_UPDATE', { action: 'REQUEST_WITHDRAWAL', userId, amount, walletAddress });
  }

  static async requestWithdrawalInternal(userId: number, amount: number, walletAddress: string) {
    const systemConfigResult = await query(
      'SELECT withdraw_enabled FROM system_config WHERE id = 1'
    );
    let withdrawEnabled = true;
    if (systemConfigResult.rowCount && systemConfigResult.rowCount > 0) {
      withdrawEnabled = systemConfigResult.rows[0].withdraw_enabled;
    }
    if (!withdrawEnabled) {
      throw new AppError('Withdrawals are currently disabled', 400);
    }

    const lockKey = `wallet_lock_${userId}`;
    const acquiredLock = await LockService.acquire(lockKey);
    if (!acquiredLock) {
      throw new AppError('Another transaction is processing on your wallet. Please try again.', 429);
    }

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check current user available balance with row lock
        const userResult = await client.query(
          'SELECT id, available_balance, is_suspicious, country, country_code FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );
        if (!userResult.rowCount) {
          throw new AppError('User not found', 404);
        }

        const user = userResult.rows[0];
        if (user.is_suspicious) {
          throw new AppError('Your account has been flagged for review. Withdrawals are frozen.', 403);
        }

        // Wallet operates purely in Coinz (secure server verification)
        const { ConfigService } = require('./config.service');
        const sysConfig = await ConfigService.getSystemConfig();

        const minWithdrawalCoins = Number(sysConfig.withdrawal_minimum) / 1000000.0;
        const maxWithdrawalCoins = Number(sysConfig.withdrawal_maximum) / 1000000.0;

        const amountInCoinz = amount;

        if (amountInCoinz < minWithdrawalCoins) {
          throw new AppError(`Minimum withdrawal amount is ${minWithdrawalCoins} Coinz / ${minWithdrawalCoins} كونز`, 400);
        }

        if (amountInCoinz > maxWithdrawalCoins) {
          throw new AppError(`Maximum withdrawal amount is ${maxWithdrawalCoins} Coinz / ${maxWithdrawalCoins} كونز`, 400);
        }

        // Calculate dynamic fee in Coinz
        const feeFlatMicro = BigInt(sysConfig.withdrawal_fee_flat);
        const feePercentFactor = BigInt(Math.round(sysConfig.withdrawal_fee_percentage * 100)); // e.g. 250 for 2.50%
        
        const amountMicro = BigInt(Math.round(amountInCoinz * 1000000));
        const feePercentMicro = (amountMicro * feePercentFactor) / 10000n;
        const totalFeeMicro = feeFlatMicro + feePercentMicro;

        const totalDeductMicro = amountMicro + totalFeeMicro;
        const avMicro = BigInt(user.available_balance || 0);

        if (avMicro < totalDeductMicro) {
          const balanceCoins = Number(avMicro) / 1000000;
          const feeCoins = Number(totalFeeMicro) / 1000000.0;
          throw new AppError(`Insufficient available balance (including withdrawal fee of ${feeCoins} Coinz). Requested: ${amountInCoinz} Coinz, Available: ${balanceCoins} Coinz`, 400);
        }

        // Check for any pending withdrawals to prevent spamming
        const pendingResult = await client.query(
          "SELECT id FROM withdrawals WHERE user_id = $1 AND status = 'PENDING'",
          [userId]
        );
        if (pendingResult.rowCount && pendingResult.rowCount > 0) {
          throw new AppError('You already have a pending withdrawal request. Please wait for approval.', 400);
        }

        // Deduct balance immediately upon request creation using the helper
        const totalDeductUsd = Number(totalDeductMicro) / 1000000.0;
        await this.logAndGetWalletUpdate(
          client,
          userId,
          'WITHDRAWAL_REQUEST',
          -totalDeductUsd,
          { available_balance: avMicro - totalDeductMicro },
          `Requested withdrawal of ${amount} Coinz to ${walletAddress} (Fee: ${Number(totalFeeMicro)/1000000.0} Coinz)`
        );

        // Explicitly update user_balance_cache inside transaction
        await client.query(
          `INSERT INTO user_balance_cache (user_id, balance, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = CURRENT_TIMESTAMP`,
          [userId, (avMicro - totalDeductMicro).toString()]
        );

        // Insert a ledger record with type WITHDRAWAL and status CONFIRMED (debit reserve lock)
        await client.query(
          `INSERT INTO ledger (user_id, type, amount, status)
           VALUES ($1, 'WITHDRAWAL', $2, 'CONFIRMED')`,
          [userId, totalDeductMicro.toString()]
        );

        await client.query(
          'UPDATE users SET last_withdrawal_at = NOW() WHERE id = $1',
          [userId]
        );

        // Insert withdrawal request
        const withdrawalResult = await client.query(
          `INSERT INTO withdrawals (user_id, amount, status, wallet_address)
           VALUES ($1, $2, 'PENDING', $3)
           RETURNING id, amount, status, wallet_address, created_at`,
          [userId, amountInCoinz, walletAddress]
        );

        await client.query('COMMIT');
        return withdrawalResult.rows[0];
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

  static async getWithdrawalsHistory(userId: number) {
    const result = await query(
      'SELECT id, amount, status, wallet_address, created_at, updated_at FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  }

  // Helper method to resolve AdminService call through queue wrapper
  static async processWithdrawalInternal(adminId: number, withdrawalId: number, status: 'APPROVED' | 'REJECTED') {
    const { AdminService } = require('./admin.service');
    return AdminService.processWithdrawalInternal(adminId, withdrawalId, status);
  }

  static async getVipMultiplier(tier: string): Promise<number> {
    const { ConfigService } = require('./config.service');
    const config = await ConfigService.getVipTierConfig(tier);
    return config.multiplier;
  }

  static async getVipDailyCap(tier: string): Promise<number> {
    const { ConfigService } = require('./config.service');
    const config = await ConfigService.getVipTierConfig(tier);
    return Number(config.daily_earning_cap) / 1000000.0;
  }

  static async checkAndUpdateDailyEarningCap(
    client: any,
    userId: number,
    rewardMicro: bigint,
    vipTier: string
  ): Promise<bigint> {
    const todayStr = new Date().toISOString().split('T')[0];
    
    // Lock daily control row
    let controlResult = await client.query(
      'SELECT reward_generated FROM daily_control WHERE user_id = $1 AND date = $2 FOR UPDATE',
      [userId, todayStr]
    );

    if (!controlResult.rowCount) {
      // Try insert, handle race condition if concurrent tasks try to insert first
      try {
        controlResult = await client.query(
          'INSERT INTO daily_control (user_id, date, reward_generated) VALUES ($1, $2, 0.0000) RETURNING reward_generated',
          [userId, todayStr]
        );
      } catch (err: any) {
        if (err.code === '23505') {
          controlResult = await client.query(
            'SELECT reward_generated FROM daily_control WHERE user_id = $1 AND date = $2 FOR UPDATE',
            [userId, todayStr]
          );
        } else {
          throw err;
        }
      }
    }

    const row = controlResult.rows[0];
    const earnedMicro = BigInt(Math.round(parseFloat(row.reward_generated || '0') * 1000000));
    
    const capCoins = await this.getVipDailyCap(vipTier);
    const capMicro = BigInt(Math.round(capCoins * 1000000));

    if (earnedMicro >= capMicro) {
      throw new AppError(`Daily VIP earning cap of ${capCoins} Coinz reached for today.`, 403);
    }

    const remainingMicro = capMicro - earnedMicro;
    let finalRewardMicro = rewardMicro;
    if (rewardMicro > remainingMicro) {
      finalRewardMicro = remainingMicro;
    }

    const newEarnedCoins = Number(earnedMicro + finalRewardMicro) / 1000000.0;
    await client.query(
      'UPDATE daily_control SET reward_generated = $1 WHERE user_id = $2 AND date = $3',
      [newEarnedCoins, userId, todayStr]
    );

    return finalRewardMicro;
  }
}
