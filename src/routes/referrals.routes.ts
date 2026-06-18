import { Router } from 'express';
import { ReferralsController } from '../controllers/referrals.controller';
import { authenticate } from '../middlewares/auth';

const router = Router();

router.get('/', authenticate, ReferralsController.getReferrals);

export default router;
