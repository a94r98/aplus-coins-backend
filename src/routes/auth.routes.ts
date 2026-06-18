import { Router } from 'express';
import {
  AuthController,
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from '../controllers/auth.controller';
import { validate } from '../middlewares/validation';
import { authLimiter } from '../middlewares/rateLimiter';
import { authenticate } from '../middlewares/auth';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), AuthController.register);
router.post('/login', authLimiter, validate(loginSchema), AuthController.login);
router.post('/verify-email', authLimiter, validate(verifyEmailSchema), AuthController.verifyEmail);
router.post('/resend-verification', authLimiter, validate(resendVerificationSchema), AuthController.resendVerification);
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), AuthController.forgotPassword);
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), AuthController.resetPassword);
router.get('/countries', AuthController.getCountries);

router.put('/profile', authenticate, validate(updateProfileSchema), AuthController.updateProfile);
router.delete('/profile', authenticate, AuthController.deleteAccount);

export default router;
