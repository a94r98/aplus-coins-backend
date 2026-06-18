import { Router } from 'express';
import {
  AdminController,
  processWithdrawalSchema,
  distributePoolSchema,
  updateSystemStateSchema,
  adjustBalanceSchema,
  updateSystemConfigSchema,
  countrySchema,
  updateCountrySchema,
  withdrawMethodSchema,
  updateWithdrawMethodSchema,
  adProviderSchema,
  updateAdProviderSchema,
  updateEconomyConfigSchema,
} from '../controllers/admin.controller';
import { validate } from '../middlewares/validation';
import { authenticate, requireAdmin } from '../middlewares/auth';

const router = Router();

// Secure all admin routes with authentication and requireAdmin check
router.use(authenticate, requireAdmin);

router.post('/withdrawals/process', validate(processWithdrawalSchema), AdminController.processWithdrawal);
router.post('/reward-pool/distribute', validate(distributePoolSchema), AdminController.distributePool);
router.get('/stats', AdminController.getStats);
router.get('/withdrawals', AdminController.getWithdrawals);
router.get('/logs', AdminController.getLogs);

// Production Hardening Admin Routes
router.post('/system-state', validate(updateSystemStateSchema), AdminController.updateSystemState);
router.post('/reconcile', AdminController.runReconciliation);
router.post('/users/:userId/audit', AdminController.auditUserRewards);

// User administration
router.post('/users/:userId/block', AdminController.blockUser);
router.post('/users/:userId/unblock', AdminController.unblockUser);
router.post('/users/:userId/balance', validate(adjustBalanceSchema), AdminController.adjustUserBalance);

// System config
router.get('/config/system', AdminController.getSystemConfig);
router.post('/config/system', validate(updateSystemConfigSchema), AdminController.updateSystemConfig);
router.get('/config/economy', AdminController.getEconomyConfig);
router.post('/config/economy', validate(updateEconomyConfigSchema), AdminController.updateEconomyConfig);

// Countries CRUD
router.get('/countries', AdminController.getCountries);
router.post('/countries', validate(countrySchema), AdminController.addCountry);
router.put('/countries/:id', validate(updateCountrySchema), AdminController.updateCountry);
router.delete('/countries/:id', AdminController.deleteCountry);

// Withdraw Methods CRUD
router.get('/withdraw-methods', AdminController.getWithdrawMethods);
router.post('/withdraw-methods', validate(withdrawMethodSchema), AdminController.addWithdrawMethod);
router.put('/withdraw-methods/:id', validate(updateWithdrawMethodSchema), AdminController.updateWithdrawMethod);
router.delete('/withdraw-methods/:id', AdminController.deleteWithdrawMethod);

// Ad Providers CRUD
router.get('/ad-providers', AdminController.getAdProviders);
router.post('/ad-providers', validate(adProviderSchema), AdminController.addAdProvider);
router.put('/ad-providers/:id', validate(updateAdProviderSchema), AdminController.updateAdProvider);
router.delete('/ad-providers/:id', AdminController.deleteAdProvider);

export default router;
