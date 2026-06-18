import { Router } from 'express';
import { NotificationController } from '../controllers/notification.controller';
import { authenticate } from '../middlewares/auth';

const router = Router();

router.use(authenticate);

router.get('/', NotificationController.getNotifications);
router.post('/:id/read', NotificationController.markAsRead);

export default router;
