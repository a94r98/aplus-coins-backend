import { Response, NextFunction } from 'express';
import { ReferralService } from '../services/referral.service';
import { AuthenticatedRequest } from '../middlewares/auth';

export class ReferralsController {
  static async getReferrals(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const stats = await ReferralService.getReferralsStats(userId);
      res.status(200).json({
        status: 'success',
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }
}
