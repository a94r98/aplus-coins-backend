import { Router } from 'express';
import { StoreController, createOrderSchema } from '../controllers/store.controller';
import { validate } from '../middlewares/validation';
import { authenticate } from '../middlewares/auth';

const router = Router();

router.use(authenticate);

router.post('/orders', validate(createOrderSchema), StoreController.createOrder);
router.get('/orders', StoreController.getOrderHistory);

export default router;
