import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { WalletService } from '../services/wallet.service';
import { AuthenticatedRequest } from '../middlewares/auth';
import { HardeningService } from '../services/hardening.service';
import { query } from '../config/db';

export const upgradeVipSchema = z.object({
  body: z.object({
    tier: z.enum(['VIP1', 'VIP2', 'VIP3', 'VIP4', 'VIP5', 'VIP6', 'VIP7', 'VIP8', 'VIP9', 'VIP10'], {
      errorMap: () => ({ message: 'Tier must be one of VIP1 to VIP10' }),
    }),
  }),
});

export const withdrawSchema = z.object({
  body: z.object({
    amount: z.number().positive('Amount must be positive'),
    walletAddress: z.string().min(5, 'Invalid wallet address'),
  }),
});

export class WalletController {
  static async upgradeVip(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { tier } = req.body;
      const result = await WalletService.upgradeVip(userId, tier);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async requestWithdrawal(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { amount, walletAddress } = req.body;
      const result = await WalletService.requestWithdrawal(userId, amount, walletAddress);
      res.status(201).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getWithdrawals(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const history = await WalletService.getWithdrawalsHistory(userId);
      res.status(200).json({
        status: 'success',
        results: history.length,
        data: history,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getDetails(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      // Auto audit user rewards before showing details
      await HardeningService.auditUserRewards(userId);

      const cacheResult = await query(
        'SELECT balance FROM user_balance_cache WHERE user_id = $1',
        [userId]
      );
      const cachedAv = cacheResult.rowCount ? BigInt(cacheResult.rows[0].balance || 0) : BigInt(0);

      const result = await query(
        'SELECT id, username, email, vip_tier, referral_code, balance, pending_balance, total_earned, total_withdrawn, last_withdrawal_at, country, country_code, language, notifications_enabled FROM users WHERE id = $1',
        [userId]
      );
      const user = result.rows[0];

      const todayStr = new Date().toISOString().split('T')[0];
      const dailyCountResult = await query(
        `SELECT COUNT(*) as count FROM ad_logs 
         WHERE user_id = $1 AND watched_date = $2`,
        [userId, todayStr]
      );
      const todayAdCount = parseInt(dailyCountResult.rows[0].count, 10);

      const { AdsService } = require('../services/ads.service');
      const { limit: dailyLimit } = await AdsService.getAdLimits(user.vip_tier);

      res.status(200).json({
        status: 'success',
        data: {
          id: user.id,
          username: user.username,
          email: user.email,
          vip_tier: user.vip_tier,
          referral_code: user.referral_code,
          balance: parseFloat(user.balance),
          available_balance: Number(cachedAv) / 1000000,
          pending_balance: Number(user.pending_balance || 0) / 1000000,
          total_earned: Number(user.total_earned || 0) / 1000000,
          total_withdrawn: Number(user.total_withdrawn || 0) / 1000000,
          last_withdrawal_at: user.last_withdrawal_at,
          ads_watched_today: todayAdCount,
          max_daily_ads: dailyLimit,
          country: user.country,
          country_code: user.country_code,
          language: user.language,
          notifications_enabled: user.notifications_enabled,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async getWithdrawMethods(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { AdminService } = require('../services/admin.service');
      const result = await AdminService.getWithdrawMethods();
      const activeMethods = result.filter((m: any) => m.is_active);
      res.status(200).json({
        status: 'success',
        data: activeMethods,
      });
    } catch (error) {
      next(error);
    }
  }
}
