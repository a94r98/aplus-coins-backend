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

export const buyProductSchema = z.object({
  productId: z.number().int().positive(),
});

export class StoreController {
  static async getProducts(req: Request, res: Response, next: NextFunction) {
    try {
      const products = await StoreService.getActiveProducts();
      res.status(200).json({
        status: 'success',
        data: products,
      });
    } catch (error) {
      next(error);
    }
  }

  static async buyProduct(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { productId } = req.body;

      const result = await StoreService.buyProduct(userId, productId);
      res.status(200).json({
        status: 'success',
        message: `Successfully purchased ${result.product_name}`,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}
