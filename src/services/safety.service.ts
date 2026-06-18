import { query } from '../config/db';
import { HardeningService } from './hardening.service';

export class SafetyService {
  private static inFlightPayouts = 0;
  private static cachedDbPayoutsToday = 0;
  private static cachedPoolLimitToday = 0;
  private static lastSyncTime = 0;
  private static currentDate = '';

  private static async syncIfNeeded() {
    const today = new Date().toISOString().split('T')[0];
    const now = Date.now();
    
    // Sync cache every 5 seconds or when the day rolls over
    if (this.currentDate !== today || now - this.lastSyncTime > 5000) {
      this.currentDate = today;
      this.lastSyncTime = now;

      // 1. Get total payouts (rewards + shares) today
      const payoutResult = await query(
        `SELECT COALESCE(SUM(reward_generated), 0) + COALESCE(SUM(shares_earned), 0) as total 
         FROM daily_control WHERE date = $1`,
        [today]
      );
      this.cachedDbPayoutsToday = parseFloat(payoutResult.rows[0].total || '0');

      // 2. Get today's total revenue from reward_pool
      const poolResult = await query(
        "SELECT SUM(total_revenue) as total FROM reward_pool WHERE pool_date = $1",
        [today]
      );
      const totalRevenue = parseFloat(poolResult.rows[0].total || '0');
      this.cachedPoolLimitToday = totalRevenue * 0.35; // 35% daily pool limit
    }
  }

  /**
   * Acquires a slot for a pending payout.
   * Instantly routes to LIMITED_MODE and returns false if aggregate payouts cross 35% daily pool limit.
   */
  static async checkAndAcquirePayout(estimatedAmount: number): Promise<boolean> {
    await this.syncIfNeeded();

    const aggregatePayout = this.cachedDbPayoutsToday + (this.inFlightPayouts / 1000000) + estimatedAmount;

    // If pool limit is set/active and we cross 35%
    if (this.cachedPoolLimitToday > 0 && aggregatePayout > this.cachedPoolLimitToday) {
      const currentState = await HardeningService.getSystemState();
      if (currentState !== 'LIMITED_MODE') {
        await HardeningService.setSystemState('LIMITED_MODE');
        await query(
          "INSERT INTO admin_logs (admin_id, action, details) VALUES (1, 'SYSTEM_STATE_CHANGE', $1)",
          [`Financial Hard Stop Semaphore: Aggregate pending payouts ($${aggregatePayout.toFixed(4)}) under active threads crossed 35% of daily pool limit ($${this.cachedPoolLimitToday.toFixed(4)}). Instantly routed to LIMITED_MODE.`]
        );
      }
      return false;
    }

    // Convert estimatedAmount to micro-units for in-flight tracking
    this.inFlightPayouts += Math.round(estimatedAmount * 1000000);
    return true;
  }

  /**
   * Releases the acquired slot. If successful, updates the cached payouts.
   */
  static releasePayout(estimatedAmount: number, success: boolean) {
    const amountMicro = Math.round(estimatedAmount * 1000000);
    this.inFlightPayouts = Math.max(0, this.inFlightPayouts - amountMicro);
    if (success) {
      this.cachedDbPayoutsToday += estimatedAmount;
    }
  }
}
