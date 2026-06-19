import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthService } from '../services/auth.service';

export const registerSchema = z.object({
  body: z.object({
    username: z.string().min(3).max(50),
    email: z.string().email(),
    password: z.string().min(6),
    phone: z.string().max(30).optional().nullable(),
    country: z.string().min(2).max(100),
    countryCode: z.string().min(2).max(10),
    age: z.number().int().min(16).max(100),
    deviceFingerprint: z.string().min(1),
    referralCode: z.string().optional(),
    gender: z.enum(['MALE', 'FEMALE']).optional().nullable(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(6),
  }),
});

export const verifyEmailSchema = z.object({
  body: z.object({
    token: z.string().min(1),
  }),
});

export const resendVerificationSchema = z.object({
  body: z.object({
    email: z.string().email(),
  }),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email(),
  }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(1),
    newPassword: z.string().min(6),
  }),
});


export class AuthController {
  static async register(req: Request, res: Response, next: NextFunction) {
    try {
      const { username, email, password, phone, country, countryCode, age, deviceFingerprint, referralCode, gender } = req.body;
      const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '';
      
      const result = await AuthService.register({
        username,
        email,
        password_raw: password,
        phone: phone || null,
        country,
        country_code: countryCode,
        age,
        device_fingerprint: deviceFingerprint,
        ipAddress,
        referrerCode: referralCode,
        gender: gender || null,
      });
      
      res.status(201).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password } = req.body;
      const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '';
      
      const result = await AuthService.login(email, password, ipAddress);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async verifyEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const { token } = req.body;
      const result = await AuthService.verifyEmail(token);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async resendVerification(req: Request, res: Response, next: NextFunction) {
    try {
      const { email } = req.body;
      const result = await AuthService.resendVerification(email);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { email } = req.body;
      const result = await AuthService.forgotPassword(email);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { token, newPassword } = req.body;
      const result = await AuthService.resetPassword(token, newPassword);
      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getCountries(req: Request, res: Response, next: NextFunction) {
    try {
      const { AdminService } = require('../services/admin.service');
      const result = await AdminService.getCountries();
      const activeCountries = result.filter((c: any) => c.is_active);
      res.status(200).json({
        status: 'success',
        data: activeCountries,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateProfile(req: any, res: Response, next: NextFunction) {
    try {
      const userId = req.user.id;
      const { username, language, notifications_enabled, fcm_token } = req.body;
      const { query } = require('../config/db');
      
      const fields: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (username !== undefined) {
        fields.push(`username = $${paramIndex++}`);
        values.push(username);
      }
      if (language !== undefined) {
        fields.push(`language = $${paramIndex++}`);
        values.push(language);
      }
      if (notifications_enabled !== undefined) {
        fields.push(`notifications_enabled = $${paramIndex++}`);
        values.push(notifications_enabled);
      }
      if (fcm_token !== undefined) {
        fields.push(`fcm_token = $${paramIndex++}`);
        values.push(fcm_token);
      }

      if (fields.length === 0) {
        return res.status(400).json({
          status: 'error',
          message: 'لم يتم تقديم أي حقول للتحديث',
        });
      }

      values.push(userId);
      const queryStr = `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex}`;
      await query(queryStr, values);

      res.status(200).json({
        status: 'success',
        message: 'تم تحديث البيانات بنجاح',
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteAccount(req: any, res: Response, next: NextFunction) {
    try {
      const userId = req.user.id;
      const { query } = require('../config/db');
      
      await query('DELETE FROM users WHERE id = $1', [userId]);
      res.status(200).json({
        status: 'success',
        message: 'تم حذف الحساب بنجاح',
      });
    } catch (error) {
      next(error);
    }
  }
}

export const updateProfileSchema = z.object({
  body: z.object({
    username: z.string().min(3).max(50).optional(),
    language: z.string().min(2).max(10).optional(),
    notifications_enabled: z.boolean().optional(),
    fcm_token: z.string().nullable().optional(),
  }),
});
