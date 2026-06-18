import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { globalLimiter } from './middlewares/rateLimiter';
import { idempotency } from './middlewares/idempotency';
import router from './routes';
import { errorHandler, AppError } from './middlewares/error';

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(idempotency);
app.use(morgan('dev'));
app.use(globalLimiter);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// API Routes
app.use('/api/v1', router);

// Unhandled route fallback
app.all('*', (req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

// Centralized error handler
app.use(errorHandler);

export default app;
