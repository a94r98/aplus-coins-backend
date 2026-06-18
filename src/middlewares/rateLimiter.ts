import rateLimit from 'express-rate-limit';

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many requests from this IP, please try again after 15 minutes',
  },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Limit each IP to 15 auth requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many authentication attempts, please try again after 15 minutes',
  },
});

export const adWatchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 5, // max 5 ad watch submissions per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => {
    const ip = req.ip || req.socket.remoteAddress || '';
    const userId = req.user?.id ? `user_${req.user.id}` : '';
    const deviceFingerprint = req.body?.deviceFingerprint || req.headers['x-device-fingerprint'] || '';
    return `${ip}:${userId}:${deviceFingerprint}`;
  },
  message: {
    status: 'error',
    message: 'Ad watch rate limit exceeded. Please wait.',
  },
});
