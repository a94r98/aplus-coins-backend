import { query } from '../config/db';

export interface SystemConfig {
  ads_enabled: boolean;
  withdraw_enabled: boolean;
  registration_enabled: boolean;
  max_accounts_per_device: number;
  daily_checkin_reward: string;
  banner_click_reward: string;
  referral_signup_reward: string;
  coinz_iqd_rate: number;
  ad_reward_min: string;
  ad_reward_max: string;
  vip_daily_claim_duration: number;
  withdrawal_minimum: string;
  withdrawal_maximum: string;
  withdrawal_fee_percentage: number;
  withdrawal_fee_flat: string;
}

export interface VipTierConfig {
  tier: string;
  price_usd: string;
  multiplier: number;
  daily_earning_cap: string;
  daily_ad_limit: number;
}

export class ConfigService {
  private static systemConfigCache: SystemConfig | null = null;
  private static vipConfigCache: Map<string, VipTierConfig> = new Map();

  static clearCache() {
    this.systemConfigCache = null;
    this.vipConfigCache.clear();
  }

  static async getSystemConfig(): Promise<SystemConfig> {
    if (this.systemConfigCache) {
      return this.systemConfigCache;
    }

    const res = await query('SELECT * FROM system_config WHERE id = 1');
    if (!res.rowCount) {
      throw new Error('System configuration is missing in database.');
    }

    const row = res.rows[0];
    this.systemConfigCache = {
      ads_enabled: !!row.ads_enabled,
      withdraw_enabled: !!row.withdraw_enabled,
      registration_enabled: !!row.registration_enabled,
      max_accounts_per_device: parseInt(row.max_accounts_per_device, 10) || 1,
      daily_checkin_reward: row.daily_checkin_reward || '100000',
      banner_click_reward: row.banner_click_reward || '200000',
      referral_signup_reward: row.referral_signup_reward || '100000',
      coinz_iqd_rate: parseFloat(row.coinz_iqd_rate) || 1600.0,
      ad_reward_min: row.ad_reward_min || '10000',
      ad_reward_max: row.ad_reward_max || '20000',
      vip_daily_claim_duration: parseInt(row.vip_daily_claim_duration, 10) || 30,
      withdrawal_minimum: row.withdrawal_minimum || '10000000',
      withdrawal_maximum: row.withdrawal_maximum || '100000000',
      withdrawal_fee_percentage: parseFloat(row.withdrawal_fee_percentage) || 0.0,
      withdrawal_fee_flat: row.withdrawal_fee_flat || '0',
    };

    return this.systemConfigCache;
  }

  static async getVipTierConfig(tier: string): Promise<VipTierConfig> {
    const key = tier.toUpperCase();
    if (this.vipConfigCache.has(key)) {
      return this.vipConfigCache.get(key)!;
    }

    const res = await query('SELECT * FROM vip_tiers_config WHERE tier = $1', [key]);
    if (!res.rowCount) {
      // Fallback defaults if not found
      let fallbackPrice = '0';
      let fallbackMultiplier = 0.0;
      let fallbackCap = '1000000';
      let fallbackAdLimit = 5;

      if (key === 'VIP1') {
        fallbackPrice = '50000000';
        fallbackMultiplier = 0.05;
        fallbackCap = '2000000';
        fallbackAdLimit = 10;
      } else if (key === 'VIP2') {
        fallbackPrice = '100000000';
        fallbackMultiplier = 0.10;
        fallbackCap = '3000000';
        fallbackAdLimit = 20;
      } else if (key === 'VIP3') {
        fallbackPrice = '250000000';
        fallbackMultiplier = 0.15;
        fallbackCap = '5000000';
        fallbackAdLimit = 30;
      }

      const fallback: VipTierConfig = {
        tier: key,
        price_usd: fallbackPrice,
        multiplier: fallbackMultiplier,
        daily_earning_cap: fallbackCap,
        daily_ad_limit: fallbackAdLimit,
      };
      
      this.vipConfigCache.set(key, fallback);
      return fallback;
    }

    const row = res.rows[0];
    const config: VipTierConfig = {
      tier: row.tier,
      price_usd: row.price_usd || '0',
      multiplier: parseFloat(row.multiplier) || 0.0,
      daily_earning_cap: row.daily_earning_cap || '1000000',
      daily_ad_limit: parseInt(row.daily_ad_limit, 10) || 5,
    };

    this.vipConfigCache.set(key, config);
    return config;
  }

  static async getVipTiersConfigList(): Promise<VipTierConfig[]> {
    const res = await query('SELECT * FROM vip_tiers_config ORDER BY price_usd ASC');
    return res.rows.map(row => ({
      tier: row.tier,
      price_usd: row.price_usd || '0',
      multiplier: parseFloat(row.multiplier) || 0.0,
      daily_earning_cap: row.daily_earning_cap || '1000000',
      daily_ad_limit: parseInt(row.daily_ad_limit, 10) || 5,
    }));
  }
}
