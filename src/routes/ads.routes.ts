import { Router } from 'express';
import { AdsController, watchAdSchema } from '../controllers/ads.controller';
import { validate } from '../middlewares/validation';
import { authenticate } from '../middlewares/auth';
import { adWatchLimiter } from '../middlewares/rateLimiter';

const router = Router();

router.use(authenticate);

router.post('/watch', adWatchLimiter, validate(watchAdSchema), AdsController.watchAd);
router.get('/history', AdsController.getHistory);
router.get('/banners', AdsController.getActiveBanners);

export default router;
