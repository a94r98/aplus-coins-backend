import { Router } from 'express';
import { VipController } from '../controllers/vip.controller';
import { authenticate } from '../middlewares/auth';

const router = Router();

router.use(authenticate);

router.get('/daily-reward', VipController.getDailyRewardStatus);
router.post('/daily-reward/claim', VipController.claimDailyReward);

export default router;
