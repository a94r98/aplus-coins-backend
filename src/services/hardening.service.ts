import { pool, query } from '../config/db';
import { AdminService } from './admin.service';
import { WalletService } from './wallet.service';

export type SystemState = 'NORMAL' | 'BALANCE_MODE' | 'LIMITED_MODE';

export class HardeningService {
  private static cachedSystemState: SystemState | null = null;
  private static systemStateCacheTime = 0;
  private static readonly SYSTEM_STATE_CACHE_TTL = 5000; // 5 seconds

  /**
   * Retrieves the current system state.
   */
  static async getSystemState(): Promise<SystemState> {
    const now = Date.now();
    if (this.cachedSystemState && (now - this.systemStateCacheTime < this.SYSTEM_STATE_CACHE_TTL)) {
      return this.cachedSystemState;
    }
    try {
      const result = await query('SELECT system_state FROM system_state_config WHERE id = 1');
      if (!result.rowCount) {
        this.cachedSystemState = 'NORMAL';
      } else {
        this.cachedSystemState = result.rows[0].system_state as SystemState;
      }
      this.systemStateCacheTime = now;
      return this.cachedSystemState;
    } catch (error) {
      return this.cachedSystemState || 'NORMAL';
    }
  }

  /**
   * Updates the system state.
   */
  static async setSystemState(state: SystemState): Promise<void> {
    await query(
      'INSERT INTO system_state_config (id, system_state, updated_at) VALUES (1, $1, NOW()) ON CONFLICT (id) DO UPDATE SET system_state = EXCLUDED.system_state, updated_at = NOW()',
      [state]
    );
    this.cachedSystemState = state;
    this.systemStateCacheTime = Date.now();
  }

  /**
   * Lock and freeze reward generation for a date.
   */
  static async settleDate(dateStr: string): Promise<void> {
    await query(
      'INSERT INTO daily_settlements (settlement_date, is_locked, settled_at) VALUES ($1, TRUE, NOW()) ON CONFLICT (settlement_date) DO UPDATE SET is_locked = TRUE, settled_at = NOW()',
      [dateStr]
    );
  }

  /**
   * Checks if a specific date is settled/locked.
   */
  static async isDateSettled(dateStr: string): Promise<boolean> {
    const result = await query(
      'SELECT is_locked FROM daily_settlements WHERE settlement_date = $1',
      [dateStr]
    );
    return !!(result.rowCount && result.rowCount > 0 && result.rows[0].is_locked === true);
  }

  /**
   * Move clean pending rewards to available balance.
   * reward = PENDING -> audit -> AVAILABLE.
   */
  static async auditUserRewards(userId: number): Promise<{ approved: number; flagged: boolean }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if user is suspicious
      const userResult = await client.query(
        'SELECT id, is_suspicious, pending_balance, available_balance, total_earned FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (!userResult.rowCount) {
        throw new Error('User not found');
      }

      const user = userResult.rows[0];
      const pendingMicro = BigInt(user.pending_balance || 0);

      if (pendingMicro <= 0n) {
        await client.query('COMMIT');
        return { approved: 0, flagged: user.is_suspicious };
      }

      if (user.is_suspicious) {
        // Do not promote pending rewards for suspicious users
        await client.query('COMMIT');
        return { approved: 0, flagged: true };
      }

      // Check if there are any suspicious ad logs for this user that haven't been resolved
      const suspiciousResult = await client.query(
        'SELECT COUNT(*) as count FROM ad_logs WHERE user_id = $1 AND is_suspicious = TRUE',
        [userId]
      );
      const suspiciousCount = parseInt(suspiciousResult.rows[0].count, 10);

      if (suspiciousCount > 0) {
        // If there are suspicious ad logs, mark user as suspicious and do not approve
        await client.query(
          'UPDATE users SET is_suspicious = TRUE WHERE id = $1',
          [userId]
        );
        await client.query('COMMIT');
        return { approved: 0, flagged: true };
      }

      // If clean, promote pending balance to available using the helper
      const newAvailable = BigInt(user.available_balance || 0) + pendingMicro;
      const newTotalEarned = BigInt(user.total_earned || 0) + pendingMicro;

      await WalletService.logAndGetWalletUpdate(
        client,
        userId,
        'REWARD_AUDIT',
        Number(pendingMicro) / 1000000,
        {
          pending_balance: 0n,
          available_balance: newAvailable,
          total_earned: newTotalEarned
        },
        `Audited and approved rewards. Promoted pending balance to available.`
      );

      // Log audit action in admin logs
      await client.query(
        `INSERT INTO admin_logs (admin_id, action, details) 
         VALUES (1, 'REWARD_AUDIT', $1)`,
        [`Audited and approved rewards for user ID ${userId}. Amount: $${(Number(pendingMicro) / 1000000).toFixed(4)}`]
      );

      await client.query('COMMIT');
      return { approved: Number(pendingMicro) / 1000000, flagged: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Run auto-reconciliation task to verify system totals and freeze suspicious users.
   */
  static async runAutoReconciliation(): Promise<{ reconciledUsers: number; frozenUsers: number }> {
    const usersResult = await query(
      'SELECT id, available_balance, pending_balance, total_earned, total_withdrawn, is_suspicious FROM users'
    );
    let reconciledUsers = 0;
    let frozenUsers = 0;

    for (const user of usersResult.rows) {
      const userId = user.id;
      const av = BigInt(user.available_balance || 0);
      const pb = BigInt(user.pending_balance || 0);
      const te = BigInt(user.total_earned || 0);
      const tw = BigInt(user.total_withdrawn || 0);

      // Verify mathematical integrity: total_earned >= available_balance + total_withdrawn
      // Also, total_earned should ideally be equal to total_withdrawn + available_balance + pending_balance (if we don't count active/pending withdrawals in total_withdrawn)
      // Since withdrawals deduct available_balance, the sum of available_balance + total_withdrawn + pending_balance + any active pending withdrawal amount should match total_earned.
      // Let's check for simple anomalies: if total_earned < available_balance or total_earned < total_withdrawn
      let anomalyDetected = false;
      if (te < av || te < tw || (av + tw + pb) > te * 11n / 10n) { // Allow slight buffer or check strictly
        anomalyDetected = true;
      }

      // Check for suspicious ad speeds
      const logsResult = await query(
        'SELECT watched_at FROM ad_logs WHERE user_id = $1 ORDER BY watched_at ASC',
        [userId]
      );
      
      let lastTime = 0;
      for (const log of logsResult.rows) {
        const time = new Date(log.watched_at).getTime();
        if (lastTime > 0) {
          const diff = (time - lastTime) / 1000;
          if (diff < 28) { // 30s threshold with 2s leeway
            anomalyDetected = true;
            break;
          }
        }
        lastTime = time;
      }

      if (anomalyDetected && !user.is_suspicious) {
        await query(
          "UPDATE users SET is_suspicious = TRUE WHERE id = $1",
          [userId]
        );
        await query(
          "INSERT INTO admin_logs (admin_id, action, details) VALUES (1, 'FRAUD_FREEZE', $1)",
          [`Reconciliation flagged anomalies for User ID ${userId}. Account frozen.`]
        );
        frozenUsers++;
      }
      reconciledUsers++;
    }

    return { reconciledUsers, frozenUsers };
  }

  /**
   * Financial Safety Engine - Hard Stop Rule & Revenue Buffer check.
   * If daily payout exceeds 35% of ad revenue, automatically downgrade system state to LIMITED_MODE.
   */
  static async checkFinancialSafeguards(): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    
    // Get total reward generated today
    const payoutResult = await query(
      "SELECT SUM(reward_generated) as total FROM daily_control WHERE date = $1",
      [today]
    );
    const totalPayout = parseFloat(payoutResult.rows[0].total || '0');

    // Get today's total revenue from reward_pool or ad logs
    const poolResult = await query(
      "SELECT SUM(total_revenue) as total FROM reward_pool WHERE pool_date = $1",
      [today]
    );
    const totalRevenue = parseFloat(poolResult.rows[0].total || '0');

    if (totalRevenue > 0) {
      const payoutPercentage = totalPayout / totalRevenue;
      if (payoutPercentage > 0.35) {
        // Downgrade to LIMITED_MODE
        await this.setSystemState('LIMITED_MODE');
        await query(
          "INSERT INTO admin_logs (admin_id, action, details) VALUES (1, 'SYSTEM_STATE_CHANGE', $1)",
          [`Financial Hard Stop: Daily payout ($${totalPayout}) exceeded 35% of ad revenue ($${totalRevenue}). Downgraded system to LIMITED_MODE.`]
        );
      }
    }
  }

  /**
   * Checks for fraud on an ad watch.
   */
  static async checkFraudAndFlag(userId: number, adId: string, clientIp: string, deviceFingerprint?: string): Promise<boolean> {
    // 1. Check if same device fingerprint is used by multiple users
    if (deviceFingerprint) {
      const multiUserResult = await query(
        "SELECT COUNT(DISTINCT id) as count FROM users WHERE device_fingerprint = $1 AND id != $2",
        [deviceFingerprint, userId]
      );
      const otherUsersCount = parseInt(multiUserResult.rows[0].count, 10);
      if (otherUsersCount >= 2) {
        await query(
          "UPDATE users SET is_suspicious = TRUE WHERE id = $1",
          [userId]
        );
        return true;
      }
    }

    // 2. Speed / cooldown check (30s)
    const lastAdResult = await query(
      'SELECT watched_at FROM ad_logs WHERE user_id = $1 ORDER BY watched_at DESC LIMIT 1',
      [userId]
    );
    if (lastAdResult.rowCount && lastAdResult.rowCount > 0) {
      const lastWatched = new Date(lastAdResult.rows[0].watched_at).getTime();
      const diff = (Date.now() - lastWatched) / 1000;
      if (diff < 28) {
        await query(
          "UPDATE users SET is_suspicious = TRUE WHERE id = $1",
          [userId]
        );
        return true;
      }
    }

    // 3. Repeated ad_ids (current day only)
    const repeatedAdResult = await query(
      'SELECT COUNT(*) as count FROM ad_logs WHERE user_id = $1 AND ad_id = $2 AND watched_date = CURRENT_DATE',
      [userId, adId]
    );
    const count = parseInt(repeatedAdResult.rows[0].count, 10);
    if (count > 0) {
      return true;
    }

    return false;
  }
}
