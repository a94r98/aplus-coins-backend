import { Response, NextFunction } from 'express';
import { VipService } from '../services/vip.service';
import { AuthenticatedRequest } from '../middlewares/auth';

export class VipController {
  static async getDailyRewardStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const status = await VipService.getDailyRewardStatus(userId);
      res.status(200).json({
        status: 'success',
        data: status,
      });
    } catch (error) {
      next(error);
    }
  }

  static async claimDailyReward(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const result = await VipService.claimDailyReward(userId);
      res.status(200).json({
        status: 'success',
        message: 'Daily VIP reward claimed successfully.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}
