import { AdsService } from './ads.service';
import { RewardsService } from './rewards.service';
import { WalletService } from './wallet.service';
import { AdminService } from './admin.service';

export interface Job {
  id: string;
  type: 'AD_VALIDATION' | 'SHARE_CALCULATION' | 'WALLET_UPDATE';
  data: any;
  resolve: (value: any) => void;
  reject: (err: any) => void;
}

export class QueueService {
  private static queue: Job[] = [];
  private static activeWorkers = 0;
  private static maxConcurrency = 10; // Concurrency limit to prevent DB bottlenecks

  static async enqueue(type: Job['type'], data: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).substring(2, 15);
      this.queue.push({ id, type, data, resolve, reject });
      this.processQueue();
    });
  }

  private static async processQueue() {
    if (this.activeWorkers >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    this.activeWorkers++;
    const job = this.queue.shift()!;

    // Process worker execution asynchronously to keep the queue loop responsive
    setImmediate(async () => {
      try {
        const result = await this.executeJob(job);
        job.resolve(result);
      } catch (err) {
        job.reject(err);
      } finally {
        this.activeWorkers--;
        this.processQueue();
      }
    });
  }

  private static async executeJob(job: Job): Promise<any> {
    switch (job.type) {
      case 'AD_VALIDATION': {
        const { userId, adId, options } = job.data;
        return await AdsService.watchAdInternal(userId, adId, options);
      }
      case 'SHARE_CALCULATION': {
        const { totalRevenue } = job.data;
        return await RewardsService.createAndDistributePoolInternal(totalRevenue);
      }
      case 'WALLET_UPDATE': {
        const { action, userId, amount, walletAddress, tier, shareId, status, adminId, withdrawalId } = job.data;
        if (action === 'UPGRADE_VIP') {
          return await WalletService.upgradeVipInternal(userId, tier);
        } else if (action === 'REQUEST_WITHDRAWAL') {
          return await WalletService.requestWithdrawalInternal(userId, amount, walletAddress);
        } else if (action === 'CLAIM_DAILY_SHARE') {
          return await RewardsService.claimDailyShareInternal(userId, shareId);
        } else if (action === 'PROCESS_WITHDRAWAL') {
          return await AdminService.processWithdrawalInternal(adminId, withdrawalId, status);
        } else {
          throw new Error(`Unknown wallet update action: ${action}`);
        }
      }
      default:
        throw new Error(`Unknown job type: ${job.type}`);
    }
  }
}
