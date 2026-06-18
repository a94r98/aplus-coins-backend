import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthService } from '../services/auth.service';

export const registerSchema = z.object({
  body: z.object({
    username: z.string().min(3).max(50),
    email: z.string().email(),
    password: z.string().min(6),
    phone: z.string().min(5).max(30),
    country: z.string().min(2).max(100),
    countryCode: z.string().min(2).max(10),
    age: z.number().int().min(16).max(100),
    deviceFingerprint: z.string().min(1),
    referralCode: z.string().optional(),
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
      const { username, email, password, phone, country, countryCode, age, deviceFingerprint, referralCode } = req.body;
      const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '';
      
      const result = await AuthService.register({
        username,
        email,
        password_raw: password,
        phone,
        country,
        country_code: countryCode,
        age,
        device_fingerprint: deviceFingerprint,
        ipAddress,
        referrerCode: referralCode,
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
}
