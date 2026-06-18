import { Router } from 'express';
import { RewardsController, claimShareSchema } from '../controllers/rewards.controller';
import { OneTimeTasksController, claimOneTimeTaskSchema } from '../controllers/oneTimeTasks.controller';
import { validate } from '../middlewares/validation';
import { authenticate } from '../middlewares/auth';

const router = Router();

router.use(authenticate);

router.get('/unclaimed', RewardsController.getUnclaimed);
router.post('/claim', validate(claimShareSchema), RewardsController.claimShare);

router.get('/daily-tasks/status', RewardsController.getDailyTasksStatus);
router.post('/daily-tasks/check-in', RewardsController.claimCheckIn);
router.post('/daily-tasks/banner-click', RewardsController.claimBannerClick);

router.get('/one-time-tasks', OneTimeTasksController.getTasks);
router.post('/one-time-tasks/claim', validate(claimOneTimeTaskSchema), OneTimeTasksController.claimTask);

export default router;
