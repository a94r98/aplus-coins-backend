import { Router } from 'express';
import { StoreController, buyProductSchema } from '../controllers/store.controller';
import { validate } from '../middlewares/validation';
import { authenticate } from '../middlewares/auth';

const router = Router();

router.use(authenticate);

router.get('/products', StoreController.getProducts);
router.post('/buy', validate(buyProductSchema), StoreController.buyProduct);

export default router;
