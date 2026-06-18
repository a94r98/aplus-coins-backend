import { Router } from 'express';
import authRoutes from './auth.routes';
import adsRoutes from './ads.routes';
import adsWebhookRoutes from './ads.webhook';
import rewardsRoutes from './rewards.routes';
import walletRoutes from './wallet.routes';
import referralsRoutes from './referrals.routes';
import adminRoutes from './admin.routes';
import storeRoutes from './store.routes';
import vipRoutes from './vip.routes';
import notificationRoutes from './notification.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/ads/webhooks', adsWebhookRoutes);
router.use('/ads', adsRoutes);
router.use('/rewards', rewardsRoutes);
router.use('/wallet', walletRoutes);
router.use('/referrals', referralsRoutes);
router.use('/admin', adminRoutes);
router.use('/store', storeRoutes);
router.use('/vip', vipRoutes);
router.use('/notifications', notificationRoutes);

export default router;
