import { query } from '../config/db';
import { AppError } from '../middlewares/error';

export interface Notification {
  id: number;
  user_id: number;
  title: string;
  body: string;
  type: string;
  is_read: boolean;
  created_at: Date;
}

export class NotificationService {
  static async createNotification(
    userId: number,
    title: string,
    body: string,
    type: string = 'GENERAL'
  ): Promise<Notification> {
    const res = await query(
      `INSERT INTO notifications (user_id, title, body, type)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, title, body, type, is_read, created_at`,
      [userId, title, body, type]
    );
    return res.rows[0];
  }

  static async getUserNotifications(userId: number): Promise<Notification[]> {
    const res = await query(
      `SELECT id, user_id, title, body, type, is_read, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    return res.rows;
  }

  static async markAsRead(userId: number, notificationId: number): Promise<void> {
    const res = await query(
      `UPDATE notifications
       SET is_read = TRUE
       WHERE id = $1 AND user_id = $2`,
      [notificationId, userId]
    );
    if (res.rowCount === 0) {
      throw new AppError('Notification not found', 404);
    }
  }
}
