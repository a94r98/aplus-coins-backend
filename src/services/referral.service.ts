import { PoolClient } from 'pg';
import { query } from '../config/db';

export class ReferralService {
  /**
   * Calculates the decayed commission based on the time elapsed since the referral was created.
   * Decay scheme:
   *  - <= 30 days:   Level 1: 10%  | Level 2: 5%   | Level 3: 2%
   *  - 31-90 days:   Level 1: 5%   | Level 2: 2.5% | Level 3: 1%
   *  - 91-180 days:  Level 1: 2%   | Level 2: 1%   | Level 3: 0.5%
   *  - > 180 days:   Level 1: 1%   | Level 2: 0.5% | Level 3: 0.1%
   */
  static getCommissionRate(level: number, daysElapsed: number): number {
    if (daysElapsed <= 30) {
      if (level === 1) return 0.10;
      if (level === 2) return 0.05;
      if (level === 3) return 0.02;
    } else if (daysElapsed <= 90) {
      if (level === 1) return 0.05;
      if (level === 2) return 0.025;
      if (level === 3) return 0.01;
    } else if (daysElapsed <= 180) {
      if (level === 1) return 0.02;
      if (level === 2) return 0.01;
      if (level === 3) return 0.005;
    } else {
      if (level === 1) return 0.01;
      if (level === 2) return 0.005;
      if (level === 3) return 0.001;
    }
    return 0;
  }

  static async processAdWatchCommission(client: PoolClient, referredUserId: number, adReward: number) {
    // Get referrers for this user at all levels
    const referralsResult = await client.query(
      `SELECT r.id, r.referrer_id, r.level, r.created_at, u.username
       FROM referrals r
       JOIN users u ON r.referrer_id = u.id
       WHERE r.referred_id = $1`,
      [referredUserId]
    );

    const now = new Date();

    // Sort referrers by ID ascending to avoid database deadlock conditions
    const sortedReferrals = [...referralsResult.rows].sort((a, b) => a.referrer_id - b.referrer_id);

    for (const ref of sortedReferrals) {
      // Lock referrer row
      const referrerResult = await client.query('SELECT id, pending_balance FROM users WHERE id = $1 FOR UPDATE', [ref.referrer_id]);

      const referralDate = new Date(ref.created_at);
      const diffTime = Math.abs(now.getTime() - referralDate.getTime());
      const daysElapsed = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      const rate = this.getCommissionRate(ref.level, daysElapsed);
      const commission = adReward * rate;

      if (commission > 0) {
        const commissionMicro = BigInt(Math.round(commission * 1000000));
        const currentPb = BigInt(referrerResult.rows[0].pending_balance || 0);

        // Update referrer's pending_balance using WalletService helper
        const { WalletService } = require('./wallet.service');
        await WalletService.logAndGetWalletUpdate(
          client,
          ref.referrer_id,
          'REFERRAL_COMMISSION',
          commission,
          { pending_balance: currentPb + commissionMicro },
          `Referral commission from user ID ${referredUserId}`
        );

        // Update referrals record with cumulative commission earned
        await client.query(
          'UPDATE referrals SET commission_earned = commission_earned + $1 WHERE id = $2',
          [commission, ref.id]
        );
      }
    }
  }

  static async getReferralsStats(userId: number) {
    const summary = await query(
      `SELECT 
         COUNT(CASE WHEN level = 1 THEN 1 END) as level1_count,
         COUNT(CASE WHEN level = 2 THEN 1 END) as level2_count,
         COUNT(CASE WHEN level = 3 THEN 1 END) as level3_count,
         COALESCE(SUM(commission_earned), 0) as total_commissions
       FROM referrals
       WHERE referrer_id = $1`,
      [userId]
    );

    const details = await query(
      `SELECT r.level, r.commission_earned, r.created_at, u.username, u.email, u.vip_tier
       FROM referrals r
       JOIN users u ON r.referred_id = u.id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC`,
      [userId]
    );

    return {
      summary: {
        level1: parseInt(summary.rows[0].level1_count || '0', 10),
        level2: parseInt(summary.rows[0].level2_count || '0', 10),
        level3: parseInt(summary.rows[0].level3_count || '0', 10),
        total_commissions: parseFloat(summary.rows[0].total_commissions),
      },
      referrals: details.rows,
    };
  }
}
