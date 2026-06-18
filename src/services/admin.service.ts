import { pool, query } from '../config/db';
import { AppError } from '../middlewares/error';
import { WalletService } from './wallet.service';

export class AdminService {
  static async logAdminAction(client: any, adminId: number, action: string, details: string) {
    await client.query(
      'INSERT INTO admin_logs (admin_id, action, details) VALUES ($1, $2, $3)',
      [adminId, action, details]
    );
  }

  static async processWithdrawal(adminId: number, withdrawalId: number, status: 'APPROVED' | 'REJECTED') {
    const { QueueService } = require('./queue.service');
    return QueueService.enqueue('WALLET_UPDATE', { action: 'PROCESS_WITHDRAWAL', adminId, withdrawalId, status });
  }

  static async processWithdrawalInternal(adminId: number, withdrawalId: number, status: 'APPROVED' | 'REJECTED') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Fetch withdrawal
      const withdrawalResult = await client.query(
        'SELECT id, user_id, amount, status FROM withdrawals WHERE id = $1 FOR UPDATE',
        [withdrawalId]
      );

      if (!withdrawalResult.rowCount) {
        throw new AppError('Withdrawal request not found', 404);
      }

      const withdrawal = withdrawalResult.rows[0];
      if (withdrawal.status !== 'PENDING') {
        throw new AppError(`Withdrawal has already been processed as ${withdrawal.status}`, 400);
      }

      // Lock user row first for strict transactions
      await client.query(
        'SELECT id, available_balance, total_withdrawn FROM users WHERE id = $1 FOR UPDATE',
        [withdrawal.user_id]
      );

      // Update withdrawal status
      await client.query(
        'UPDATE withdrawals SET status = $1 WHERE id = $2',
        [status, withdrawalId]
      );

      // If approved, increment total_withdrawn
      if (status === 'APPROVED') {
        const amountMicro = BigInt(Math.round(parseFloat(withdrawal.amount) * 1000000));
        const userResult = await client.query('SELECT total_withdrawn FROM users WHERE id = $1 FOR UPDATE', [withdrawal.user_id]);
        const userTw = BigInt(userResult.rows[0].total_withdrawn || 0);
        await WalletService.logAndGetWalletUpdate(
          client,
          withdrawal.user_id,
          'WITHDRAWAL_APPROVED',
          parseFloat(withdrawal.amount),
          { total_withdrawn: userTw + amountMicro },
          `Withdrawal ID ${withdrawalId} approved by Admin ${adminId}`
        );
      }

      // If rejected, refund the user available_balance and balance
      if (status === 'REJECTED') {
        const amountMicro = BigInt(Math.round(parseFloat(withdrawal.amount) * 1000000));
        const userResult = await client.query('SELECT available_balance FROM users WHERE id = $1 FOR UPDATE', [withdrawal.user_id]);
        const userAv = BigInt(userResult.rows[0].available_balance || 0);
        await WalletService.logAndGetWalletUpdate(
          client,
          withdrawal.user_id,
          'WITHDRAWAL_REJECTED',
          parseFloat(withdrawal.amount),
          { available_balance: userAv + amountMicro },
          `Withdrawal ID ${withdrawalId} rejected by Admin ${adminId}. Balance refunded.`
        );

        // Explicitly update user_balance_cache inside transaction
        await client.query(
          `INSERT INTO user_balance_cache (user_id, balance, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = CURRENT_TIMESTAMP`,
          [withdrawal.user_id, (userAv + amountMicro).toString()]
        );

        // Insert refund ledger entry
        await client.query(
          `INSERT INTO ledger (user_id, type, amount, status)
           VALUES ($1, 'REFUND', $2, 'CONFIRMED')`,
          [withdrawal.user_id, amountMicro.toString()]
        );
      }

      // Log admin action
      await this.logAdminAction(
        client,
        adminId,
        `${status}_WITHDRAWAL`,
        `Withdrawal ID: ${withdrawalId}, User ID: ${withdrawal.user_id}, Amount: $${withdrawal.amount}`
      );

      await client.query('COMMIT');
      return {
        id: withdrawalId,
        status,
        refunded: status === 'REJECTED',
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getPlatformStats() {
    const usersCount = await query('SELECT COUNT(*) as count FROM users');
    const activeVipsCount = await query("SELECT COUNT(DISTINCT user_id) as count FROM subscriptions WHERE status = 'ACTIVE' AND expires_at > NOW()");
    const totalAdsWatched = await query('SELECT COUNT(*) as count FROM ad_logs');
    const totalWithdrawals = await query("SELECT SUM(amount) as total FROM withdrawals WHERE status = 'APPROVED'");
    const pendingWithdrawalsCount = await query("SELECT COUNT(*) as count FROM withdrawals WHERE status = 'PENDING'");

    return {
      total_users: parseInt(usersCount.rows[0].count, 10),
      active_vips: parseInt(activeVipsCount.rows[0].count, 10),
      total_ads_watched: parseInt(totalAdsWatched.rows[0].count, 10),
      total_withdrawn: parseFloat(totalWithdrawals.rows[0].total || '0'),
      pending_withdrawals_count: parseInt(pendingWithdrawalsCount.rows[0].count, 10),
    };
  }

  static async getAllWithdrawals() {
    const result = await query(
      `SELECT w.id, w.amount, w.status, w.wallet_address, w.created_at, u.username, u.email
       FROM withdrawals w
       JOIN users u ON w.user_id = u.id
       ORDER BY w.created_at DESC`
    );
    return result.rows;
  }

  static async getAdminLogs() {
    const result = await query(
      `SELECT al.id, al.action, al.details, al.created_at, u.username as admin_username
       FROM admin_logs al
       JOIN users u ON al.admin_id = u.id
       ORDER BY al.created_at DESC`
    );
    return result.rows;
  }

  static async blockUser(adminId: number, userId: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userResult = await client.query('SELECT id, is_blocked FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!userResult.rowCount) {
        throw new AppError('User not found', 404);
      }
      await client.query('UPDATE users SET is_blocked = TRUE WHERE id = $1', [userId]);
      await this.logAdminAction(client, adminId, 'BLOCK_USER', `Blocked user ID ${userId}`);
      await client.query('COMMIT');
      return { userId, is_blocked: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async unblockUser(adminId: number, userId: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userResult = await client.query('SELECT id, is_blocked FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!userResult.rowCount) {
        throw new AppError('User not found', 404);
      }
      await client.query('UPDATE users SET is_blocked = FALSE WHERE id = $1', [userId]);
      await this.logAdminAction(client, adminId, 'UNBLOCK_USER', `Unblocked user ID ${userId}`);
      await client.query('COMMIT');
      return { userId, is_blocked: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async adjustUserBalance(adminId: number, userId: number, amountDelta: number, reason?: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Lock user row first
      const userResult = await client.query(
        'SELECT id, available_balance, balance, pending_balance, total_earned, total_withdrawn FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (!userResult.rowCount) {
        throw new AppError('User not found', 404);
      }

      const user = userResult.rows[0];
      const beforeAv = BigInt(user.available_balance || 0);
      const amountDeltaMicro = BigInt(Math.round(amountDelta * 1000000));
      const afterAv = beforeAv + amountDeltaMicro;

      if (afterAv < 0n) {
        throw new AppError('Adjustment would result in negative available balance', 400);
      }

      const balanceUsd = Number(afterAv) / 1000000;

      // Update user
      await client.query(
        `UPDATE users 
         SET available_balance = $1, 
             balance = $2
         WHERE id = $3`,
        [afterAv.toString(), balanceUsd, userId]
      );

      // Insert wallet audit log
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
          userId, 'ADMIN_ADJUSTMENT', amountDelta,
          beforeAv.toString(), afterAv.toString(),
          user.pending_balance.toString(), user.pending_balance.toString(),
          user.total_earned.toString(), user.total_earned.toString(),
          user.total_withdrawn.toString(), user.total_withdrawn.toString(),
          reason || 'Admin manual balance adjustment'
        ]
      );

      // Insert ledger entry
      await client.query(
        `INSERT INTO ledger (user_id, type, amount, status)
         VALUES ($1, 'ADMIN_ADJUSTMENT', $2, 'CONFIRMED')`,
        [userId, amountDeltaMicro.toString()]
      );

      // Explicitly update user_balance_cache
      await client.query(
        `INSERT INTO user_balance_cache (user_id, balance, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = CURRENT_TIMESTAMP`,
        [userId, afterAv.toString()]
      );

      // Log admin action
      await this.logAdminAction(
        client,
        adminId,
        'ADJUST_BALANCE',
        `Adjusted User ID ${userId} balance by $${amountDelta}. Reason: ${reason || 'N/A'}`
      );

      await client.query('COMMIT');
      return {
        userId,
        previous_balance: Number(beforeAv) / 1000000,
        new_balance: balanceUsd,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getSystemConfig() {
    const result = await query('SELECT * FROM system_config WHERE id = 1');
    return result.rows[0];
  }

  static async updateSystemConfig(
    adminId: number,
    updates: {
      ads_enabled?: boolean;
      withdraw_enabled?: boolean;
      registration_enabled?: boolean;
      max_accounts_per_device?: number;
    }
  ) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const currentConfigResult = await client.query('SELECT * FROM system_config WHERE id = 1 FOR UPDATE');
      if (!currentConfigResult.rowCount) {
        // Seed if missing
        await client.query(
          `INSERT INTO system_config (id, ads_enabled, withdraw_enabled, registration_enabled, max_accounts_per_device)
           VALUES (1, TRUE, TRUE, TRUE, 1)`
        );
      }

      const updatesList: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (updates.ads_enabled !== undefined) {
        updatesList.push(`ads_enabled = $${paramIndex++}`);
        values.push(updates.ads_enabled);
      }
      if (updates.withdraw_enabled !== undefined) {
        updatesList.push(`withdraw_enabled = $${paramIndex++}`);
        values.push(updates.withdraw_enabled);
      }
      if (updates.registration_enabled !== undefined) {
        updatesList.push(`registration_enabled = $${paramIndex++}`);
        values.push(updates.registration_enabled);
      }
      if (updates.max_accounts_per_device !== undefined) {
        updatesList.push(`max_accounts_per_device = $${paramIndex++}`);
        values.push(updates.max_accounts_per_device);
      }

      if (updatesList.length > 0) {
        values.push(1); // For the WHERE id = $X clause
        const queryText = `UPDATE system_config SET ${updatesList.join(', ')} WHERE id = $${paramIndex}`;
        await client.query(queryText, values);
      }

      await this.logAdminAction(client, adminId, 'UPDATE_SYSTEM_CONFIG', JSON.stringify(updates));
      await client.query('COMMIT');

      const finalResult = await query('SELECT * FROM system_config WHERE id = 1');
      return finalResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getEconomyConfig() {
    const { ConfigService } = require('./config.service');
    const systemConfig = await ConfigService.getSystemConfig();
    const vipTiersConfig = await ConfigService.getVipTiersConfigList();
    return {
      systemConfig,
      vipTiersConfig,
    };
  }

  static async updateEconomyConfig(
    adminId: number,
    payload: {
      systemConfig?: {
        ads_enabled?: boolean;
        withdraw_enabled?: boolean;
        registration_enabled?: boolean;
        max_accounts_per_device?: number;
        daily_checkin_reward?: string | number;
        banner_click_reward?: string | number;
        referral_signup_reward?: string | number;
        coinz_iqd_rate?: number;
        ad_reward_min?: string | number;
        ad_reward_max?: string | number;
        vip_daily_claim_duration?: number;
        withdrawal_minimum?: string | number;
        withdrawal_maximum?: string | number;
        withdrawal_fee_percentage?: number;
        withdrawal_fee_flat?: string | number;
      };
      vipTiersConfig?: Array<{
        tier: string;
        price_usd: string | number;
        multiplier: number;
        daily_earning_cap: string | number;
        daily_ad_limit: number;
      }>;
    }
  ) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update System Config if present
      if (payload.systemConfig) {
        const sc = payload.systemConfig;
        const updatesList: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        const fields = [
          'ads_enabled', 'withdraw_enabled', 'registration_enabled', 'max_accounts_per_device',
          'daily_checkin_reward', 'banner_click_reward', 'referral_signup_reward',
          'coinz_iqd_rate', 'ad_reward_min', 'ad_reward_max', 'vip_daily_claim_duration',
          'withdrawal_minimum', 'withdrawal_maximum', 'withdrawal_fee_percentage', 'withdrawal_fee_flat'
        ];

        for (const f of fields) {
          if ((sc as any)[f] !== undefined) {
            updatesList.push(`${f} = $${paramIndex++}`);
            values.push((sc as any)[f]);
          }
        }

        if (updatesList.length > 0) {
          values.push(1); // WHERE id = 1
          const queryText = `UPDATE system_config SET ${updatesList.join(', ')} WHERE id = $${paramIndex}`;
          await client.query(queryText, values);
        }
      }

      // Update VIP Tier Config if present
      if (payload.vipTiersConfig) {
        for (const tierConf of payload.vipTiersConfig) {
          await client.query(
            `INSERT INTO vip_tiers_config (tier, price_usd, multiplier, daily_earning_cap, daily_ad_limit)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (tier) DO UPDATE SET
               price_usd = EXCLUDED.price_usd,
               multiplier = EXCLUDED.multiplier,
               daily_earning_cap = EXCLUDED.daily_earning_cap,
               daily_ad_limit = EXCLUDED.daily_ad_limit`,
            [
              tierConf.tier.toUpperCase(),
              tierConf.price_usd.toString(),
              tierConf.multiplier,
              tierConf.daily_earning_cap.toString(),
              tierConf.daily_ad_limit
            ]
          );
        }
      }

      // Clear the config cache to apply changes immediately
      const { ConfigService } = require('./config.service');
      ConfigService.clearCache();

      await this.logAdminAction(client, adminId, 'UPDATE_ECONOMY_CONFIG', JSON.stringify(payload));
      await client.query('COMMIT');

      return await this.getEconomyConfig();
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Countries CRUD
  static async getCountries() {
    const result = await query('SELECT * FROM countries ORDER BY name ASC');
    return result.rows;
  }

  static async addCountry(adminId: number, code: string, name: string, is_active = true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO countries (code, name, is_active)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [code.toUpperCase(), name, is_active]
      );
      await this.logAdminAction(client, adminId, 'ADD_COUNTRY', `Added country: ${name} (${code})`);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateCountry(adminId: number, id: number, updates: { code?: string; name?: string; is_active?: boolean }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updatesList: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (updates.code !== undefined) {
        updatesList.push(`code = $${paramIndex++}`);
        values.push(updates.code.toUpperCase());
      }
      if (updates.name !== undefined) {
        updatesList.push(`name = $${paramIndex++}`);
        values.push(updates.name);
      }
      if (updates.is_active !== undefined) {
        updatesList.push(`is_active = $${paramIndex++}`);
        values.push(updates.is_active);
      }

      values.push(id);
      const queryText = `UPDATE countries SET ${updatesList.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
      const result = await client.query(queryText, values);

      await this.logAdminAction(client, adminId, 'UPDATE_COUNTRY', `Updated country ID ${id}`);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async deleteCountry(adminId: number, id: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM countries WHERE id = $1', [id]);
      await this.logAdminAction(client, adminId, 'DELETE_COUNTRY', `Deleted country ID ${id}`);
      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Withdraw Methods CRUD
  static async getWithdrawMethods() {
    const result = await query('SELECT * FROM withdraw_methods ORDER BY name ASC');
    return result.rows;
  }

  static async addWithdrawMethod(adminId: number, key: string, name: string, is_active = true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO withdraw_methods (key, name, is_active)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [key.toUpperCase(), name, is_active]
      );
      await this.logAdminAction(client, adminId, 'ADD_WITHDRAW_METHOD', `Added withdraw method: ${name} (${key})`);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateWithdrawMethod(adminId: number, id: number, updates: { key?: string; name?: string; is_active?: boolean }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updatesList: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (updates.key !== undefined) {
        updatesList.push(`key = $${paramIndex++}`);
        values.push(updates.key.toUpperCase());
      }
      if (updates.name !== undefined) {
        updatesList.push(`name = $${paramIndex++}`);
        values.push(updates.name);
      }
      if (updates.is_active !== undefined) {
        updatesList.push(`is_active = $${paramIndex++}`);
        values.push(updates.is_active);
      }

      values.push(id);
      const queryText = `UPDATE withdraw_methods SET ${updatesList.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
      const result = await client.query(queryText, values);

      await this.logAdminAction(client, adminId, 'UPDATE_WITHDRAW_METHOD', `Updated withdraw method ID ${id}`);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async deleteWithdrawMethod(adminId: number, id: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM withdraw_methods WHERE id = $1', [id]);
      await this.logAdminAction(client, adminId, 'DELETE_WITHDRAW_METHOD', `Deleted withdraw method ID ${id}`);
      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Ad Providers CRUD
  static async getAdProviders() {
    const result = await query('SELECT * FROM ad_providers ORDER BY name ASC');
    return result.rows;
  }

  static async addAdProvider(adminId: number, provider_key: string, name: string, keys_config: any, secret_encrypted = false, is_active = true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO ad_providers (provider_key, name, keys_config, secret_encrypted, rotated_at, is_active)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)
         RETURNING *`,
        [provider_key.toUpperCase(), name, JSON.stringify(keys_config), secret_encrypted, is_active]
      );
      await this.logAdminAction(client, adminId, 'ADD_AD_PROVIDER', `Added ad provider: ${name} (${provider_key})`);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateAdProvider(
    adminId: number,
    id: number,
    updates: {
      provider_key?: string;
      name?: string;
      keys_config?: any;
      secret_encrypted?: boolean;
      is_active?: boolean;
      rotated_at?: boolean; // if true, update rotated_at to NOW
    }
  ) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updatesList: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (updates.provider_key !== undefined) {
        updatesList.push(`provider_key = $${paramIndex++}`);
        values.push(updates.provider_key.toUpperCase());
      }
      if (updates.name !== undefined) {
        updatesList.push(`name = $${paramIndex++}`);
        values.push(updates.name);
      }
      if (updates.keys_config !== undefined) {
        updatesList.push(`keys_config = $${paramIndex++}`);
        values.push(JSON.stringify(updates.keys_config));
      }
      if (updates.secret_encrypted !== undefined) {
        updatesList.push(`secret_encrypted = $${paramIndex++}`);
        values.push(updates.secret_encrypted);
      }
      if (updates.is_active !== undefined) {
        updatesList.push(`is_active = $${paramIndex++}`);
        values.push(updates.is_active);
      }
      if (updates.rotated_at) {
        updatesList.push(`rotated_at = CURRENT_TIMESTAMP`);
      }

      values.push(id);
      const queryText = `UPDATE ad_providers SET ${updatesList.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
      const result = await client.query(queryText, values);

      await this.logAdminAction(client, adminId, 'UPDATE_AD_PROVIDER', `Updated ad provider ID ${id}`);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async deleteAdProvider(adminId: number, id: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM ad_providers WHERE id = $1', [id]);
      await this.logAdminAction(client, adminId, 'DELETE_AD_PROVIDER', `Deleted ad provider ID ${id}`);
      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
