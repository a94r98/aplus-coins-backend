import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AdsService } from '../services/ads.service';
import { AuthenticatedRequest } from '../middlewares/auth';

export const watchAdSchema = z.object({
  body: z.object({
    adId: z.string().min(1, 'adId is required'),
    requestHash: z.string().optional(),
    deviceFingerprint: z.string().optional(),
    clientTimestamp: z.number({ required_error: 'clientTimestamp is required' }),
  }),
});

export class AdsController {
  static async watchAd(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { adId, requestHash, deviceFingerprint, clientTimestamp } = req.body;
      const result = await AdsService.watchAd(userId, adId, {
        requestHash,
        deviceFingerprint,
        clientTimestamp,
        ip: req.ip || req.socket.remoteAddress || '',
      });
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getHistory(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const history = await AdsService.getHistory(userId, limit);
      res.status(200).json({
        status: 'success',
        results: history.length,
        data: history,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getActiveBanners(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const banners = await AdsService.getActiveBanners();
      res.status(200).json({
        status: 'success',
        results: banners.length,
        data: banners,
      });
    } catch (error) {
      next(error);
    }
  }
}
