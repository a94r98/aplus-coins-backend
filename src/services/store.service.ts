import { pool, query } from '../config/db';
import { AppError } from '../middlewares/error';
import { WalletService } from './wallet.service';
import { LockService } from './lock.service';

export interface StoreProduct {
  id: number;
  name: string;
  description: string;
  coins_price: number;
  vip_tier_grant?: string | null;
  is_active: boolean;
  created_at: Date;
}

export class StoreService {
  static async getActiveProducts(): Promise<StoreProduct[]> {
    const res = await query(
      'SELECT id, name, description, coins_price, vip_tier_grant, is_active, created_at FROM store_products WHERE is_active = TRUE ORDER BY id ASC'
    );
    return res.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      // coins_price is stored as BIGINT micro-units in database. Convert to logical Coinz.
      coins_price: parseFloat(row.coins_price) / 1000000.0,
      vip_tier_grant: row.vip_tier_grant,
      is_active: row.is_active,
      created_at: row.created_at,
    }));
  }

  static async buyProduct(userId: number, productId: number) {
    const lockKey = `wallet_lock_${userId}`;
    const acquiredLock = await LockService.acquire(lockKey);
    if (!acquiredLock) {
      throw new AppError('Another transaction is processing on your wallet. Please try again.', 429);
    }

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Fetch product details
        const productRes = await client.query(
          'SELECT id, name, coins_price, vip_tier_grant, is_active FROM store_products WHERE id = $1 FOR UPDATE',
          [productId]
        );
        if (!productRes.rowCount) {
          throw new AppError('Product not found', 404);
        }

        const product = productRes.rows[0];
        if (!product.is_active) {
          throw new AppError('This product is currently unavailable', 400);
        }

        // coins_price is stored as BIGINT micro-units in database. Read directly.
        const costMicro = BigInt(product.coins_price);
        const coinsCost = Number(costMicro) / 1000000.0; // Logical Coinz representation

        // Fetch user available balance
        const userRes = await client.query(
          'SELECT id, available_balance, vip_tier FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );
        if (!userRes.rowCount) {
          throw new AppError('User not found', 404);
        }

        const user = userRes.rows[0];
        const currentAvMicro = BigInt(user.available_balance || 0);

        if (currentAvMicro < costMicro) {
          const balanceCoins = Number(currentAvMicro) / 1000000;
          throw new AppError(`Insufficient Coinz balance. This product costs ${coinsCost} Coinz. You have ${balanceCoins.toFixed(2)} Coinz.`, 400);
        }

        // Deduct balance
        const newAvMicro = currentAvMicro - costMicro;
        await WalletService.logAndGetWalletUpdate(
          client,
          userId,
          'STORE_PURCHASE',
          -coinsCost,
          { available_balance: newAvMicro },
          `Purchased product: ${product.name}`
        );

        // Insert ledger record
        await client.query(
          `INSERT INTO ledger (user_id, type, amount, status)
           VALUES ($1, 'STORE_PURCHASE', $2, 'CONFIRMED')`,
          [userId, (-costMicro).toString()]
        );

        // Grant VIP tier if specified
        if (product.vip_tier_grant) {
          await client.query(
            'UPDATE users SET vip_tier = $1 WHERE id = $2',
            [product.vip_tier_grant, userId]
          );

          // Mark old active subscriptions as expired
          await client.query(
            "UPDATE subscriptions SET status = 'EXPIRED' WHERE user_id = $1 AND status = 'ACTIVE'",
            [userId]
          );

          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 30);

          // Insert subscription record
          await client.query(
            `INSERT INTO subscriptions (user_id, tier, amount, expires_at, status)
             VALUES ($1, $2, $3, $4, 'ACTIVE')`,
            [userId, product.vip_tier_grant, coinsCost, expiresAt]
          );
        }

        await client.query('COMMIT');
        return {
          success: true,
          product_name: product.name,
          coins_price: coinsCost,
          vip_tier_granted: product.vip_tier_grant || null,
          new_balance: Number(newAvMicro) / 1000000,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } finally {
      LockService.release(lockKey);
    }
  }
}
