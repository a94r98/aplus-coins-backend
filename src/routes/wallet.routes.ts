import { Router } from 'express';
import { WalletController, upgradeVipSchema, withdrawSchema } from '../controllers/wallet.controller';
import { validate } from '../middlewares/validation';
import { authenticate } from '../middlewares/auth';

const router = Router();

router.use(authenticate);

router.post('/upgrade', validate(upgradeVipSchema), WalletController.upgradeVip);
router.post('/withdraw', validate(withdrawSchema), WalletController.requestWithdrawal);
router.get('/withdrawals', WalletController.getWithdrawals);
router.get('/details', WalletController.getDetails);
router.get('/withdraw-methods', WalletController.getWithdrawMethods);

export default router;
