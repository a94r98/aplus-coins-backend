import { Request, Response, NextFunction } from 'express';
import { StoreService } from '../services/store.service';
import { z } from 'zod';

interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    email: string;
    vip_tier: string;
  };
}

export const createOrderSchema = z.object({
  category: z.enum(['CARDS', 'CHAT_COINS', 'GAMES', 'CURRENCY_EXCHANGE']),
  productName: z.string().min(1),
  coinsPrice: z.number().positive(),
  details: z.record(z.any()),
});

export class StoreController {
  static async createOrder(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { category, productName, coinsPrice, details } = req.body;

      const order = await StoreService.createOrder(
        userId,
        category,
        productName,
        coinsPrice,
        details
      );

      res.status(200).json({
        status: 'success',
        message: 'تم تسجيل طلب الشراء بنجاح وجاري المراجعة',
        data: order,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getOrderHistory(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const orders = await StoreService.getOrderHistory(userId);
      res.status(200).json({
        status: 'success',
        data: orders,
      });
    } catch (error) {
      next(error);
    }
  }
}
