import { Request, Response, NextFunction } from 'express';
import { NotificationService } from '../services/notification.service';
import { z } from 'zod';

interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    email: string;
    vip_tier: string;
  };
}

export const readNotificationSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export class NotificationController {
  static async getNotifications(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const notifications = await NotificationService.getUserNotifications(userId);
      res.status(200).json({
        status: 'success',
        data: notifications,
      });
    } catch (error) {
      next(error);
    }
  }

  static async markAsRead(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const notificationId = Number(req.params.id);

      await NotificationService.markAsRead(userId, notificationId);
      res.status(200).json({
        status: 'success',
        message: 'Notification marked as read',
      });
    } catch (error) {
      next(error);
    }
  }
}
