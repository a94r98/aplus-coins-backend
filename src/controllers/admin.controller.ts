import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AdminService } from '../services/admin.service';
import { RewardsService } from '../services/rewards.service';
import { AuthenticatedRequest } from '../middlewares/auth';
import { HardeningService } from '../services/hardening.service';

export const processWithdrawalSchema = z.object({
  body: z.object({
    withdrawalId: z.number().int('withdrawalId must be an integer'),
    status: z.enum(['APPROVED', 'REJECTED'], {
      errorMap: () => ({ message: 'Status must be APPROVED or REJECTED' }),
    }),
  }),
});

export const distributePoolSchema = z.object({
  body: z.object({
    totalRevenue: z.number().nonnegative('Total revenue cannot be negative'),
  }),
});

export const updateSystemStateSchema = z.object({
  body: z.object({
    state: z.enum(['NORMAL', 'BALANCE_MODE', 'LIMITED_MODE'], {
      errorMap: () => ({ message: 'State must be NORMAL, BALANCE_MODE, or LIMITED_MODE' }),
    }),
  }),
});

export const adjustBalanceSchema = z.object({
  body: z.object({
    amountDelta: z.number(),
    reason: z.string().optional(),
  }),
});

export const updateSystemConfigSchema = z.object({
  body: z.object({
    ads_enabled: z.boolean().optional(),
    withdraw_enabled: z.boolean().optional(),
    registration_enabled: z.boolean().optional(),
    max_accounts_per_device: z.number().int().nonnegative().optional(),
  }),
});

export const updateEconomyConfigSchema = z.object({
  body: z.object({
    systemConfig: z.object({
      ads_enabled: z.boolean().optional(),
      withdraw_enabled: z.boolean().optional(),
      registration_enabled: z.boolean().optional(),
      max_accounts_per_device: z.number().int().nonnegative().optional(),
      daily_checkin_reward: z.union([z.string(), z.number()]).optional(),
      banner_click_reward: z.union([z.string(), z.number()]).optional(),
      referral_signup_reward: z.union([z.string(), z.number()]).optional(),
      coinz_iqd_rate: z.number().positive().optional(),
      ad_reward_min: z.union([z.string(), z.number()]).optional(),
      ad_reward_max: z.union([z.string(), z.number()]).optional(),
      vip_daily_claim_duration: z.number().int().positive().optional(),
      withdrawal_minimum: z.union([z.string(), z.number()]).optional(),
      withdrawal_maximum: z.union([z.string(), z.number()]).optional(),
      withdrawal_fee_percentage: z.number().nonnegative().optional(),
      withdrawal_fee_flat: z.union([z.string(), z.number()]).optional(),
    }).optional(),
    vipTiersConfig: z.array(z.object({
      tier: z.string().min(2),
      price_usd: z.union([z.string(), z.number()]),
      multiplier: z.number().nonnegative(),
      daily_earning_cap: z.union([z.string(), z.number()]),
      daily_ad_limit: z.number().int().positive(),
    })).optional(),
  }),
});

export const countrySchema = z.object({
  body: z.object({
    code: z.string().min(2).max(10),
    name: z.string().min(2).max(100),
    is_active: z.boolean().optional(),
  }),
});

export const updateCountrySchema = z.object({
  body: z.object({
    code: z.string().min(2).max(10).optional(),
    name: z.string().min(2).max(100).optional(),
    is_active: z.boolean().optional(),
  }),
});

export const withdrawMethodSchema = z.object({
  body: z.object({
    key: z.string().min(2).max(50),
    name: z.string().min(2).max(100),
    is_active: z.boolean().optional(),
  }),
});

export const updateWithdrawMethodSchema = z.object({
  body: z.object({
    key: z.string().min(2).max(50).optional(),
    name: z.string().min(2).max(100).optional(),
    is_active: z.boolean().optional(),
  }),
});

export const adProviderSchema = z.object({
  body: z.object({
    provider_key: z.string().min(2).max(50),
    name: z.string().min(2).max(100),
    keys_config: z.record(z.any()),
    secret_encrypted: z.boolean().optional(),
    is_active: z.boolean().optional(),
  }),
});

export const updateAdProviderSchema = z.object({
  body: z.object({
    provider_key: z.string().min(2).max(50).optional(),
    name: z.string().min(2).max(100).optional(),
    keys_config: z.record(z.any()).optional(),
    secret_encrypted: z.boolean().optional(),
    is_active: z.boolean().optional(),
    rotated_at: z.boolean().optional(),
  }),
});

export class AdminController {
  static async processWithdrawal(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const { withdrawalId, status } = req.body;
      const result = await AdminService.processWithdrawal(adminId, withdrawalId, status);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async distributePool(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { totalRevenue } = req.body;
      const result = await RewardsService.createAndDistributePool(totalRevenue);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getStats(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const stats = await AdminService.getPlatformStats();
      const systemState = await HardeningService.getSystemState();
      res.status(200).json({
        status: 'success',
        data: {
          ...stats,
          system_state: systemState,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async getWithdrawals(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const withdrawals = await AdminService.getAllWithdrawals();
      res.status(200).json({
        status: 'success',
        results: withdrawals.length,
        data: withdrawals,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getLogs(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const logs = await AdminService.getAdminLogs();
      res.status(200).json({
        status: 'success',
        results: logs.length,
        data: logs,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateSystemState(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { state } = req.body;
      await HardeningService.setSystemState(state);
      res.status(200).json({
        status: 'success',
        message: `System state updated to ${state}`,
      });
    } catch (error) {
      next(error);
    }
  }

  static async runReconciliation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await HardeningService.runAutoReconciliation();
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async auditUserRewards(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = parseInt(req.params.userId, 10);
      const result = await HardeningService.auditUserRewards(userId);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async blockUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const userId = parseInt(req.params.userId, 10);
      const result = await AdminService.blockUser(adminId, userId);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async unblockUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const userId = parseInt(req.params.userId, 10);
      const result = await AdminService.unblockUser(adminId, userId);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async adjustUserBalance(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const userId = parseInt(req.params.userId, 10);
      const { amountDelta, reason } = req.body;
      const result = await AdminService.adjustUserBalance(adminId, userId, amountDelta, reason);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async getSystemConfig(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const config = await AdminService.getSystemConfig();
      res.status(200).json({ status: 'success', data: config });
    } catch (error) {
      next(error);
    }
  }

  static async updateSystemConfig(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const result = await AdminService.updateSystemConfig(adminId, req.body);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  // Countries CRUD Controller Methods
  static async getCountries(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await AdminService.getCountries();
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async addCountry(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const { code, name, is_active } = req.body;
      const result = await AdminService.addCountry(adminId, code, name, is_active);
      res.status(201).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async updateCountry(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const id = parseInt(req.params.id, 10);
      const result = await AdminService.updateCountry(adminId, id, req.body);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async deleteCountry(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const id = parseInt(req.params.id, 10);
      const result = await AdminService.deleteCountry(adminId, id);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  // Withdraw Methods CRUD Controller Methods
  static async getWithdrawMethods(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await AdminService.getWithdrawMethods();
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async addWithdrawMethod(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const { key, name, is_active } = req.body;
      const result = await AdminService.addWithdrawMethod(adminId, key, name, is_active);
      res.status(201).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async updateWithdrawMethod(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const id = parseInt(req.params.id, 10);
      const result = await AdminService.updateWithdrawMethod(adminId, id, req.body);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async deleteWithdrawMethod(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const id = parseInt(req.params.id, 10);
      const result = await AdminService.deleteWithdrawMethod(adminId, id);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  // Ad Providers CRUD Controller Methods
  static async getAdProviders(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await AdminService.getAdProviders();
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async addAdProvider(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const { provider_key, name, keys_config, secret_encrypted, is_active } = req.body;
      const result = await AdminService.addAdProvider(adminId, provider_key, name, keys_config, secret_encrypted, is_active);
      res.status(201).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async updateAdProvider(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const id = parseInt(req.params.id, 10);
      const result = await AdminService.updateAdProvider(adminId, id, req.body);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async deleteAdProvider(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const id = parseInt(req.params.id, 10);
      const result = await AdminService.deleteAdProvider(adminId, id);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async getEconomyConfig(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const config = await AdminService.getEconomyConfig();
      res.status(200).json({
        status: 'success',
        data: config,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateEconomyConfig(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const adminId = req.user!.id;
      const config = await AdminService.updateEconomyConfig(adminId, req.body);
      res.status(200).json({
        status: 'success',
        message: 'Economy configuration updated successfully.',
        data: config,
      });
    } catch (error) {
      next(error);
    }
  }
}
