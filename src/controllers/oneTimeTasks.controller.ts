import { Response, NextFunction } from 'express';
import { OneTimeTasksService } from '../services/oneTimeTasks.service';
import { AuthenticatedRequest } from '../middlewares/auth';
import { z } from 'zod';

export const claimOneTimeTaskSchema = z.object({
  body: z.object({
    taskKey: z.string().min(2, 'Task key is required'),
    deviceFingerprint: z.string().optional(),
  }),
});

export class OneTimeTasksController {
  static async getTasks(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const tasks = await OneTimeTasksService.getOneTimeTasks(userId);
      res.status(200).json({
        status: 'success',
        data: tasks,
      });
    } catch (error) {
      next(error);
    }
  }

  static async claimTask(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { taskKey, deviceFingerprint } = req.body;
      
      // Grab client IP address safely
      const ipAddress = req.ip || req.socket.remoteAddress || '';

      const result = await OneTimeTasksService.claimOneTimeTask(
        userId,
        taskKey,
        deviceFingerprint,
        ipAddress
      );

      res.status(200).json({
        status: 'success',
        message: 'Social task reward claimed successfully.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}
