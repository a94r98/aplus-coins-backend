import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { RewardsService } from '../services/rewards.service';
import { DailyTasksService } from '../services/dailyTasks.service';
import { AuthenticatedRequest } from '../middlewares/auth';

export const claimShareSchema = z.object({
  body: z.object({
    shareId: z.number().int('shareId must be an integer'),
  }),
});

export class RewardsController {
  static async getUnclaimed(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const shares = await RewardsService.getUnclaimedShares(userId);
      res.status(200).json({
        status: 'success',
        results: shares.length,
        data: shares,
      });
    } catch (error) {
      next(error);
    }
  }

  static async claimShare(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { shareId } = req.body;
      const result = await RewardsService.claimDailyShare(userId, shareId);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getDailyTasksStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const status = await DailyTasksService.getDailyTasksStatus(userId);
      res.status(200).json({
        status: 'success',
        data: status,
      });
    } catch (error) {
      next(error);
    }
  }

  static async claimCheckIn(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const result = await DailyTasksService.claimCheckIn(userId);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async claimBannerClick(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const result = await DailyTasksService.claimBannerClick(userId);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async claimShareApp(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const result = await DailyTasksService.claimShareApp(userId);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}
