import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool, query } from '../config/db';
import { env } from '../config/env';
import { AppError } from '../middlewares/error';
import { WalletService } from './wallet.service';

export interface UserRow {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  vip_tier: string;
  referral_code: string;
  referred_by: number | null;
  balance: string;
  phone?: string | null;
  country?: string | null;
  country_code?: string | null;
  age?: number | null;
  is_verified?: boolean;
  verification_token?: string | null;
  reset_token?: string | null;
  reset_token_expires?: Date | null;
  is_blocked?: boolean;
  last_ip?: string | null;
  created_ip?: string | null;
  created_at: Date;
}

export class AuthService {
  static generateToken(user: { id: number; username: string; email: string; vip_tier: string }): string {
    return jwt.sign(
      { id: user.id, username: user.username, email: user.email, vip_tier: user.vip_tier },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as any }
    );
  }

  static generateReferralCode(): string {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  static async register(payload: {
    username: string;
    email: string;
    password_raw: string;
    phone?: string;
    country?: string;
    country_code?: string;
    age: number;
    referrerCode?: string;
    device_fingerprint?: string;
    ipAddress?: string;
    gender?: string;
  }) {
    const {
      username,
      email,
      password_raw,
      phone,
      country,
      country_code,
      age,
      referrerCode,
      device_fingerprint,
      ipAddress,
      gender,
    } = payload;

    // 1. Check if registration is enabled
    const configResult = await query(
      'SELECT registration_enabled, max_accounts_per_device FROM system_config WHERE id = 1'
    );
    let registrationEnabled = true;
    let maxAccountsPerDevice = 1;
    if (configResult.rowCount && configResult.rowCount > 0) {
      registrationEnabled = configResult.rows[0].registration_enabled;
      maxAccountsPerDevice = configResult.rows[0].max_accounts_per_device;
    }
    if (!registrationEnabled) {
      throw new AppError('Registration is currently disabled', 400);
    }

    // 2. Age limits check
    if (age < 16 || age > 100) {
      throw new AppError('Age must be between 16 and 100', 400);
    }

    // 3. Count device fingerprints
    if (device_fingerprint) {
      const deviceCheck = await query(
        'SELECT COUNT(*) as count FROM users WHERE device_fingerprint = $1',
        [device_fingerprint]
      );
      const deviceCount = parseInt(deviceCheck.rows[0].count, 10);
      if (deviceCount >= maxAccountsPerDevice) {
        throw new AppError('Maximum number of accounts per device reached', 400);
      }
    }

    // 4. Check if user already exists
    const existingUser = await query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );

    if (existingUser.rowCount && existingUser.rowCount > 0) {
      throw new AppError('Username or email already registered', 400);
    }

    const passwordHash = await bcrypt.hash(password_raw, 10);
    const userReferralCode = this.generateReferralCode();
    const verificationToken = crypto.randomBytes(32).toString('hex');

    let referredByUserId: number | null = null;

    if (referrerCode) {
      const referrer = await query('SELECT id FROM users WHERE referral_code = $1', [referrerCode]);
      if (referrer.rowCount && referrer.rowCount > 0) {
        referredByUserId = referrer.rows[0].id;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert user with the new fields
      const userInsertResult = await client.query(
        `INSERT INTO users (
          username, email, password_hash, referral_code, referred_by,
          phone, country, country_code, age, device_fingerprint,
          created_ip, last_ip, verification_token, is_verified, gender
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, TRUE, $14)
         RETURNING id, username, email, vip_tier, referral_code, referred_by, balance, phone, country, country_code, age, is_verified, is_blocked, created_at, gender`,
        [
          username, email, passwordHash, userReferralCode, referredByUserId,
          phone || null, country, country_code, age, device_fingerprint,
          ipAddress || null, ipAddress || null, verificationToken, gender || null
        ]
      );

      const newUser = userInsertResult.rows[0];

      // If referred, establish referral tree up to 3 levels
      if (referredByUserId) {
        // Level 1 referral
        await client.query(
          'INSERT INTO referrals (referrer_id, referred_id, level) VALUES ($1, $2, 1)',
          [referredByUserId, newUser.id]
        );

        const referrerLock = await client.query(
          'SELECT available_balance, total_earned, vip_tier FROM users WHERE id = $1 FOR UPDATE',
          [referredByUserId]
        );

        if (referrerLock.rowCount && referrerLock.rowCount > 0) {
          // Load referral bonus amount from DB settings dynamically
          const configRes = await client.query(
            'SELECT referral_signup_reward FROM system_config WHERE id = 1'
          );
          const baseReferralMicro = BigInt(configRes.rows[0]?.referral_signup_reward || '100000'); // Default 0.10 Coinz if not set

          const referrerTier = referrerLock.rows[0].vip_tier || 'FREE';
          const multiplier = await WalletService.getVipMultiplier(referrerTier);
          
          // Apply VIP multiplier
          const multiplierFactor = BigInt(Math.round((1 + multiplier) * 10000));
          const bonusMicro = (baseReferralMicro * multiplierFactor) / 10000n;
          const bonusAmount = Number(bonusMicro) / 1000000.0;

          const currentAv = BigInt(referrerLock.rows[0].available_balance || 0);
          const currentTe = BigInt(referrerLock.rows[0].total_earned || 0);

          await WalletService.logAndGetWalletUpdate(
            client,
            referredByUserId,
            'REFERRAL_SIGNUP_BONUS',
            bonusAmount,
            { available_balance: currentAv + bonusMicro, total_earned: currentTe + bonusMicro },
            `Referral signup bonus for inviting user ${username}`
          );

          // Insert ledger record (with standardized type REFERRAL_BONUS)
          await client.query(
            `INSERT INTO ledger (user_id, type, amount, status)
             VALUES ($1, 'REFERRAL_BONUS', $2, 'CONFIRMED')`,
            [referredByUserId, bonusMicro.toString()]
          );
        }

        // Find Level 2 referrer (the referrer of my referrer)
        const level1Referrer = await client.query('SELECT referred_by FROM users WHERE id = $1', [referredByUserId]);
        if (level1Referrer.rowCount && level1Referrer.rows[0].referred_by) {
          const level2ReferrerId = level1Referrer.rows[0].referred_by;
          await client.query(
            'INSERT INTO referrals (referrer_id, referred_id, level) VALUES ($1, $2, 2)',
            [level2ReferrerId, newUser.id]
          );

          // Find Level 3 referrer
          const level2Referrer = await client.query('SELECT referred_by FROM users WHERE id = $1', [level2ReferrerId]);
          if (level2Referrer.rowCount && level2Referrer.rows[0].referred_by) {
            const level3ReferrerId = level2Referrer.rows[0].referred_by;
            await client.query(
              'INSERT INTO referrals (referrer_id, referred_id, level) VALUES ($1, $2, 3)',
              [level3ReferrerId, newUser.id]
            );
          }
        }
      }

      await client.query('COMMIT');
      console.log(`[Email Verification] Verification token for ${email}: ${verificationToken}`);

      const token = this.generateToken(newUser);
      return { user: newUser, token };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async login(email: string, password_raw: string, ipAddress?: string) {
    const result = await query(
      `SELECT id, username, email, password_hash, vip_tier, referral_code, referred_by, balance, 
              phone, country, country_code, age, is_verified, is_blocked, created_at 
       FROM users WHERE email = $1`,
      [email]
    );

    if (!result.rowCount || result.rowCount === 0) {
      throw new AppError('Invalid email or password', 401);
    }

    const user: UserRow = result.rows[0];

    if (user.is_blocked) {
      throw new AppError('Your account has been blocked', 403);
    }

    const isPasswordValid = await bcrypt.compare(password_raw, user.password_hash);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password', 401);
    }

    if (ipAddress) {
      await query('UPDATE users SET last_ip = $1 WHERE id = $2', [ipAddress, user.id]);
      user.last_ip = ipAddress;
    }

    const token = this.generateToken(user);
    // Remove password_hash from returning object
    const { password_hash, ...userWithoutPassword } = user;
    return { user: userWithoutPassword, token };
  }

  static async verifyEmail(token: string) {
    const result = await query(
      'SELECT id, is_verified FROM users WHERE verification_token = $1',
      [token]
    );

    if (!result.rowCount || result.rowCount === 0) {
      throw new AppError('Invalid or expired verification token', 400);
    }

    const user = result.rows[0];
    if (user.is_verified) {
      return { message: 'Email is already verified' };
    }

    await query(
      'UPDATE users SET is_verified = TRUE, verification_token = NULL WHERE id = $1',
      [user.id]
    );

    return { message: 'Email verified successfully' };
  }

  static async resendVerification(email: string) {
    const result = await query(
      'SELECT id, is_verified FROM users WHERE email = $1',
      [email]
    );

    if (!result.rowCount || result.rowCount === 0) {
      throw new AppError('User not found', 404);
    }

    const user = result.rows[0];
    if (user.is_verified) {
      throw new AppError('Email is already verified', 400);
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    await query(
      'UPDATE users SET verification_token = $1 WHERE id = $2',
      [verificationToken, user.id]
    );

    console.log(`[Email Verification] Verification token for ${email}: ${verificationToken}`);

    return { token: verificationToken };
  }

  static async forgotPassword(email: string) {
    const result = await query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (!result.rowCount || result.rowCount === 0) {
      throw new AppError('User not found', 404);
    }

    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000); // 1 hour

    await query(
      'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [resetToken, expires, user.id]
    );

    console.log(`[Password Reset] Reset token for ${email}: ${resetToken}`);

    return { token: resetToken };
  }

  static async resetPassword(token: string, newPasswordRaw: string) {
    const result = await query(
      'SELECT id, reset_token_expires FROM users WHERE reset_token = $1',
      [token]
    );

    if (!result.rowCount || result.rowCount === 0) {
      throw new AppError('Invalid reset token', 400);
    }

    const user = result.rows[0];
    if (new Date() > new Date(user.reset_token_expires)) {
      throw new AppError('Reset token has expired', 400);
    }

    const passwordHash = await bcrypt.hash(newPasswordRaw, 10);
    await query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
      [passwordHash, user.id]
    );

    return { message: 'Password reset successful' };
  }
}
