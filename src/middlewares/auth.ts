import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from './error';
import { query } from '../config/db';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    username: string;
    email: string;
    vip_tier: string;
  };
}

export const authenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AppError('No token provided. Please log in.', 401));
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as {
      id: number;
      username: string;
      email: string;
      vip_tier: string;
    };

    // Check blocked status from the database dynamically
    const userCheck = await query('SELECT is_blocked FROM users WHERE id = $1', [decoded.id]);
    if (!userCheck.rowCount || userCheck.rowCount === 0) {
      return next(new AppError('User not found.', 401));
    }
    if (userCheck.rows[0].is_blocked) {
      return next(new AppError('Your account has been blocked.', 403));
    }

    req.user = decoded;
    next();
  } catch (err) {
    return next(new AppError('Invalid or expired token. Please log in again.', 401));
  }
};

export const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (!req.user || (req.user.username !== 'admin' && !req.user.email.startsWith('admin@'))) {
    return next(new AppError('Forbidden. Admin access required.', 403));
  }
  next();
};
