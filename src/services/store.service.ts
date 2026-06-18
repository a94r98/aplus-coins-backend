import { pool, query } from '../config/db';
import { AppError } from '../middlewares/error';
import { WalletService } from './wallet.service';
import { LockService } from './lock.service';
import { NotificationService } from './notification.service';

export interface StoreOrder {
  id: number;
  user_id: number;
  username?: string;
  category: 'CARDS' | 'CHAT_COINS' | 'GAMES' | 'CURRENCY_EXCHANGE';
  product_name: string;
  coins_price: number;
  details: any;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  rejection_reason?: string | null;
  created_at: Date;
}

export class StoreService {
  static async createOrder(
    userId: number,
    category: 'CARDS' | 'CHAT_COINS' | 'GAMES' | 'CURRENCY_EXCHANGE',
    productName: string,
    coinsPrice: number,
    details: any
  ): Promise<StoreOrder> {
    const lockKey = `wallet_lock_${userId}`;
    const acquiredLock = await LockService.acquire(lockKey);
    if (!acquiredLock) {
      throw new AppError('Another transaction is processing on your wallet. Please try again.', 429);
    }

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Fetch user available balance
        const userRes = await client.query(
          'SELECT id, available_balance FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );
        if (!userRes.rowCount) {
          throw new AppError('User not found', 404);
        }

        const user = userRes.rows[0];
        const costMicro = BigInt(Math.round(coinsPrice * 1000000));
        const currentAvMicro = BigInt(user.available_balance || 0);

        if (currentAvMicro < costMicro) {
          const balanceCoins = Number(currentAvMicro) / 1000000;
          throw new AppError(
            `Insufficient Coinz balance. This costs ${coinsPrice} Coinz. You have ${balanceCoins.toFixed(2)} Coinz.`,
            400
          );
        }

        // Deduct balance
        const newAvMicro = currentAvMicro - costMicro;
        await WalletService.logAndGetWalletUpdate(
          client,
          userId,
          'STORE_PURCHASE',
          -coinsPrice,
          { available_balance: newAvMicro },
          `Store order: ${productName} (${category})`
        );

        // Update balance cache
        await client.query(
          `INSERT INTO user_balance_cache (user_id, balance, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = CURRENT_TIMESTAMP`,
          [userId, newAvMicro.toString()]
        );

        // Insert ledger record
        await client.query(
          `INSERT INTO ledger (user_id, type, amount, status)
           VALUES ($1, 'STORE_PURCHASE', $2, 'CONFIRMED')`,
          [userId, (-costMicro).toString()]
        );

        // Insert order record
        const orderRes = await client.query(
          `INSERT INTO store_orders (user_id, category, product_name, coins_price, details, status)
           VALUES ($1, $2, $3, $4, $5, 'PENDING')
           RETURNING id, user_id, category, product_name, coins_price, details, status, rejection_reason, created_at`,
          [userId, category, productName, costMicro.toString(), JSON.stringify(details)]
        );

        await client.query('COMMIT');

        const row = orderRes.rows[0];
        return {
          id: row.id,
          user_id: row.user_id,
          category: row.category,
          product_name: row.product_name,
          coins_price: Number(row.coins_price) / 1000000.0,
          details: row.details,
          status: row.status,
          rejection_reason: row.rejection_reason,
          created_at: row.created_at,
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

  static async getOrderHistory(userId: number): Promise<StoreOrder[]> {
    const res = await query(
      `SELECT id, user_id, category, product_name, coins_price, details, status, rejection_reason, created_at
       FROM store_orders
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    return res.rows.map(row => ({
      id: row.id,
      user_id: row.user_id,
      category: row.category,
      product_name: row.product_name,
      coins_price: Number(row.coins_price) / 1000000.0,
      details: row.details,
      status: row.status,
      rejection_reason: row.rejection_reason,
      created_at: row.created_at,
    }));
  }

  static async getAdminOrders(): Promise<StoreOrder[]> {
    const res = await query(
      `SELECT o.id, o.user_id, u.username, o.category, o.product_name, o.coins_price, o.details, o.status, o.rejection_reason, o.created_at
       FROM store_orders o
       JOIN users u ON o.user_id = u.id
       ORDER BY o.created_at DESC`
    );
    return res.rows.map(row => ({
      id: row.id,
      user_id: row.user_id,
      username: row.username,
      category: row.category,
      product_name: row.product_name,
      coins_price: Number(row.coins_price) / 1000000.0,
      details: row.details,
      status: row.status,
      rejection_reason: row.rejection_reason,
      created_at: row.created_at,
    }));
  }

  static async approveOrder(orderId: number): Promise<void> {
    const orderRes = await query(
      'SELECT id, user_id, product_name, status FROM store_orders WHERE id = $1',
      [orderId]
    );
    if (!orderRes.rowCount) {
      throw new AppError('Order not found', 404);
    }

    const order = orderRes.rows[0];
    if (order.status !== 'PENDING') {
      throw new AppError('Order is already processed', 400);
    }

    await query(
      "UPDATE store_orders SET status = 'APPROVED' WHERE id = $1",
      [orderId]
    );

    // Create Notification
    await NotificationService.createNotification(
      order.user_id,
      'تم قبول طلب الشراء الخاص بك! 🎉',
      `لقد تم شحن/تحويل طلبك (${order.product_name}) بنجاح. شكراً لك!`,
      'STORE_ORDER'
    );
  }

  static async rejectOrder(orderId: number, rejectionReason: string): Promise<void> {
    const orderRes = await query(
      'SELECT id, user_id, product_name, coins_price, status FROM store_orders WHERE id = $1',
      [orderId]
    );
    if (!orderRes.rowCount) {
      throw new AppError('Order not found', 404);
    }

    const order = orderRes.rows[0];
    if (order.status !== 'PENDING') {
      throw new AppError('Order is already processed', 400);
    }

    const userId = order.user_id;
    const coinsPrice = Number(order.coins_price) / 1000000.0;
    const costMicro = BigInt(order.coins_price);

    const lockKey = `wallet_lock_${userId}`;
    const acquiredLock = await LockService.acquire(lockKey);
    if (!acquiredLock) {
      throw new AppError('Another transaction is processing on user wallet', 429);
    }

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Re-fetch user balance
        const userRes = await client.query(
          'SELECT available_balance FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );
        const user = userRes.rows[0];
        const currentAvMicro = BigInt(user.available_balance || 0);

        // Refund balance
        const newAvMicro = currentAvMicro + costMicro;
        await WalletService.logAndGetWalletUpdate(
          client,
          userId,
          'STORE_REFUND',
          coinsPrice,
          { available_balance: newAvMicro },
          `Refunded order: ${order.product_name}`
        );

        // Update balance cache
        await client.query(
          `INSERT INTO user_balance_cache (user_id, balance, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = CURRENT_TIMESTAMP`,
          [userId, newAvMicro.toString()]
        );

        // Insert ledger record
        await client.query(
          `INSERT INTO ledger (user_id, type, amount, status)
           VALUES ($1, 'STORE_REFUND', $2, 'CONFIRMED')`,
          [userId, costMicro.toString()]
        );

        // Update order status
        await client.query(
          "UPDATE store_orders SET status = 'REJECTED', rejection_reason = $1 WHERE id = $2",
          [rejectionReason, orderId]
        );

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } finally {
      LockService.release(lockKey);
    }

    // Create Notification
    await NotificationService.createNotification(
      userId,
      'تم رفض طلب الشراء الخاص بك ❌',
      `تم رفض طلبك لـ (${order.product_name}). السبب: ${rejectionReason}. تم إعادة الكونزات لرصيدك.`,
      'STORE_ORDER'
    );
  }
}
