-- Database schema for the Ad Reward Platform

-- Enable UUID extension if needed, though we can use SERIAL or UUID. We will use SERIAL for simplicity or UUID. Let's use SERIAL.
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    vip_tier VARCHAR(20) DEFAULT 'FREE' CHECK (vip_tier IN ('FREE', 'VIP1', 'VIP2', 'VIP3', 'VIP4', 'VIP5', 'VIP6', 'VIP7', 'VIP8', 'VIP9', 'VIP10')),
    referral_code VARCHAR(20) UNIQUE NOT NULL,
    referred_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    balance NUMERIC(15, 4) DEFAULT 0.0000 CHECK (balance >= 0),
    
    -- Production Hardening wallet columns (amounts stored in micro-units: 1 unit = 10^-6, BIGINT)
    available_balance BIGINT DEFAULT 0,
    pending_balance BIGINT DEFAULT 0,
    total_earned BIGINT DEFAULT 0,
    total_withdrawn BIGINT DEFAULT 0,
    last_withdrawal_at TIMESTAMP WITH TIME ZONE,
    
    -- Security / Fraud fields
    is_suspicious BOOLEAN DEFAULT FALSE,
    device_fingerprint VARCHAR(255),
    
    -- VIP Reward & Ad Economy v7.0 fields
    phone VARCHAR(30),
    country VARCHAR(100),
    country_code VARCHAR(10),
    age INTEGER CHECK (age IS NULL OR (age >= 16 AND age <= 100)),
    is_verified BOOLEAN DEFAULT FALSE,
    verification_token VARCHAR(255),
    reset_token VARCHAR(255),
    reset_token_expires TIMESTAMP WITH TIME ZONE,
    is_blocked BOOLEAN DEFAULT FALSE,
    last_ip VARCHAR(45),
    created_ip VARCHAR(45),
    
    language VARCHAR(10) DEFAULT 'ar',
    notifications_enabled BOOLEAN DEFAULT TRUE,
    fcm_token VARCHAR(255) DEFAULT NULL,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier VARCHAR(20) NOT NULL CHECK (tier IN ('VIP1', 'VIP2', 'VIP3', 'VIP4', 'VIP5', 'VIP6', 'VIP7', 'VIP8', 'VIP9', 'VIP10')),
    amount NUMERIC(15, 4) NOT NULL CHECK (amount >= 0),
    starts_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ad_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ad_id VARCHAR(100) NOT NULL,
    reward_amount NUMERIC(15, 4) NOT NULL CHECK (reward_amount >= 0),
    request_hash VARCHAR(64) NOT NULL,
    device_fingerprint VARCHAR(255),
    is_suspicious BOOLEAN DEFAULT FALSE,
    watched_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    watched_date DATE NOT NULL DEFAULT CURRENT_DATE,
    CONSTRAINT unique_user_ad UNIQUE (user_id, ad_id, watched_date),
    CONSTRAINT unique_user_request UNIQUE (user_id, request_hash)
);

CREATE TABLE IF NOT EXISTS reward_pool (
    id SERIAL PRIMARY KEY,
    pool_date DATE UNIQUE NOT NULL DEFAULT CURRENT_DATE,
    total_revenue NUMERIC(15, 4) NOT NULL DEFAULT 0.0000 CHECK (total_revenue >= 0),
    pool_share_split NUMERIC(15, 4) NOT NULL DEFAULT 0.0000 CHECK (pool_share_split >= 0), -- 50% for VIPs
    referral_split NUMERIC(15, 4) NOT NULL DEFAULT 0.0000 CHECK (referral_split >= 0), -- 15% for Referrals
    platform_split NUMERIC(15, 4) NOT NULL DEFAULT 0.0000 CHECK (platform_split >= 0), -- 35% for Platform
    is_distributed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_shares (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    share_date DATE NOT NULL,
    pool_share_amount NUMERIC(15, 4) NOT NULL DEFAULT 0.0000 CHECK (pool_share_amount >= 0),
    is_claimed BOOLEAN DEFAULT FALSE,
    claimed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_user_daily_share UNIQUE (user_id, share_date)
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount NUMERIC(15, 4) NOT NULL CHECK (amount > 0),
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    wallet_address VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    referrer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referred_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    commission_earned NUMERIC(15, 4) DEFAULT 0.0000 CHECK (commission_earned >= 0),
    level INTEGER NOT NULL CHECK (level >= 1 AND level <= 3), -- Supporting multi-level or simple levels
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_referral UNIQUE (referrer_id, referred_id)
);

CREATE TABLE IF NOT EXISTS admin_logs (
    id SERIAL PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action VARCHAR(100) NOT NULL,
    details TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Production Hardening - Daily control table tracking per user: user_id, date, ads_watched, shares_earned, reward_generated.
CREATE TABLE IF NOT EXISTS daily_control (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    ads_watched INTEGER DEFAULT 0,
    shares_earned NUMERIC(15, 4) DEFAULT 0.0000,
    reward_generated NUMERIC(15, 4) DEFAULT 0.0000,
    CONSTRAINT unique_user_daily_control UNIQUE (user_id, date)
);

-- Production Hardening - Idempotency key tracking table
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id SERIAL PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    response_code INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Production Hardening - System state table
CREATE TABLE IF NOT EXISTS system_state_config (
    id SERIAL PRIMARY KEY,
    system_state VARCHAR(20) NOT NULL DEFAULT 'NORMAL' CHECK (system_state IN ('NORMAL', 'BALANCE_MODE', 'LIMITED_MODE')),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Production Hardening - Daily Settlements tracking table
CREATE TABLE IF NOT EXISTS daily_settlements (
    id SERIAL PRIMARY KEY,
    settlement_date DATE UNIQUE NOT NULL,
    is_locked BOOLEAN DEFAULT FALSE,
    settled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Production Hardening - Wallet Audit Logs table
CREATE TABLE IF NOT EXISTS wallet_audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    amount NUMERIC(15, 4) NOT NULL,
    available_balance_before BIGINT NOT NULL,
    available_balance_after BIGINT NOT NULL,
    pending_balance_before BIGINT NOT NULL,
    pending_balance_after BIGINT NOT NULL,
    total_earned_before BIGINT NOT NULL,
    total_earned_after BIGINT NOT NULL,
    total_withdrawn_before BIGINT NOT NULL,
    total_withdrawn_after BIGINT NOT NULL,
    details TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- User Balance Cache Table
CREATE TABLE IF NOT EXISTS user_balance_cache (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Ledger table
CREATE TABLE IF NOT EXISTS ledger (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    amount BIGINT NOT NULL,
    status VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed default system state
INSERT INTO system_state_config (id, system_state) VALUES (1, 'NORMAL') ON CONFLICT (id) DO NOTHING;

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_ad_logs_user_date ON ad_logs(user_id, watched_at);
CREATE INDEX IF NOT EXISTS idx_daily_shares_user_date ON daily_shares(user_id, share_date);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_daily_control_user_date ON daily_control(user_id, date);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys ON idempotency_keys(key);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_audit_logs_user ON wallet_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_user_status ON ledger(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON ledger(user_id, created_at);

-- Trigger to sync available_balance from users to user_balance_cache
CREATE OR REPLACE FUNCTION update_user_balance_cache_trigger()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO user_balance_cache (user_id, balance, updated_at)
    VALUES (NEW.id, NEW.available_balance, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id) DO UPDATE
    SET balance = EXCLUDED.balance,
        updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER trigger_update_user_balance_cache
    AFTER INSERT OR UPDATE OF available_balance ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_user_balance_cache_trigger();

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_withdrawals_updated_at
    BEFORE UPDATE ON withdrawals
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- VIP Reward & Ad Economy v7.0 Tables

CREATE TABLE IF NOT EXISTS countries (
    id SERIAL PRIMARY KEY,
    code VARCHAR(10) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS withdraw_methods (
    id SERIAL PRIMARY KEY,
    key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS system_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ads_enabled BOOLEAN DEFAULT TRUE,
    withdraw_enabled BOOLEAN DEFAULT TRUE,
    registration_enabled BOOLEAN DEFAULT TRUE,
    max_accounts_per_device INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ad_providers (
    id SERIAL PRIMARY KEY,
    provider_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    keys_config JSONB,
    secret_encrypted BOOLEAN DEFAULT FALSE,
    rotated_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    total_revenue NUMERIC(15, 4) DEFAULT 0.0000
);

-- Seed Initial Data

INSERT INTO countries (code, name, is_active) VALUES
('IQ', 'Iraq', TRUE),
('SA', 'Saudi Arabia', TRUE),
('AE', 'UAE', TRUE),
('TR', 'Turkey', TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO withdraw_methods (key, name, is_active) VALUES
('USDT', 'USDT', TRUE),
('ZAIN_CASH', 'Zain Cash', TRUE),
('ASIA_HAWALA', 'Asia Hawala', TRUE),
('QI_CARD', 'Qi Card', TRUE),
('MASTERCARD', 'MasterCard', TRUE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO system_config (id, ads_enabled, withdraw_enabled, registration_enabled, max_accounts_per_device)
VALUES (1, TRUE, TRUE, TRUE, 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ad_providers (provider_key, name, keys_config, secret_encrypted, rotated_at, is_active, total_revenue) VALUES
('CPALEAD', 'CPAlead', '{"secret_key": "cpalead_secret_key_default"}'::jsonb, FALSE, CURRENT_TIMESTAMP, TRUE, 0.0000),
('UNITY_ADS', 'Unity Ads', '{"game_id": "1234567", "secret_key": "unity_secret_key_default"}'::jsonb, FALSE, CURRENT_TIMESTAMP, TRUE, 0.0000),
('APPLOVIN', 'AppLovin', '{"sdk_key": "applovin_sdk_key_default"}'::jsonb, FALSE, CURRENT_TIMESTAMP, TRUE, 0.0000)
ON CONFLICT (provider_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS advertisements (
    id SERIAL PRIMARY KEY,
    title VARCHAR(100),
    description TEXT,
    image_url VARCHAR(255) NOT NULL,
    action_url VARCHAR(255),
    reward_amount NUMERIC(15, 4) DEFAULT 0.0100, -- 0.01 Coinz = 0.01 USD
    is_active BOOLEAN DEFAULT TRUE,
    ad_type VARCHAR(20) DEFAULT 'BANNER' CHECK (ad_type IN ('BANNER', 'VIDEO', 'INTERSTITIAL')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_daily_tasks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_date DATE NOT NULL DEFAULT CURRENT_DATE,
    check_in_claimed BOOLEAN DEFAULT FALSE,
    banner_clicks_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_user_daily_task UNIQUE (user_id, task_date)
);

INSERT INTO advertisements (title, description, image_url, action_url, reward_amount, is_active, ad_type) VALUES
('A+ English Special Course', 'Upgrade your VIP tier and get access to exclusive lessons!', 'assets/images/app_icon.png', 'https://aplus-english.com/vip-course', 0.0100, TRUE, 'BANNER'),
('Earn 2.2x multiplier today!', 'Watch daily ads and multiply your earnings effortlessly.', 'assets/images/coins_stack_3d.png', 'https://aplus-english.com/vip-details', 0.0100, TRUE, 'BANNER'),
('Invite Friends, Earn Unlimited!', 'Get 5 coins for every friend who registers using your referral code.', 'assets/images/gift_box_3d.png', 'https://aplus-english.com/referrals', 0.0100, TRUE, 'BANNER')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS store_products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    coins_price BIGINT NOT NULL, -- Stored in micro-units: 1 Coinz = 1,000,000 micro-units
    vip_tier_grant VARCHAR(20),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed initial products
INSERT INTO store_products (name, description, coins_price, vip_tier_grant) VALUES
('عضوية VIP 1 / VIP 1 Upgrade', 'ترقية الحساب إلى VIP 1 لمدة 30 يوم وكسب أرباح مضاعفة 1.3x', 50000000, 'VIP1'),
('عضوية VIP 2 / VIP 2 Upgrade', 'ترقية الحساب إلى VIP 2 لمدة 30 يوم وكسب أرباح مضاعفة 1.7x', 100000000, 'VIP2'),
('عضوية VIP 3 / VIP 3 Upgrade', 'ترقية الحساب إلى VIP 3 لمدة 30 يوم وكسب أرباح مضاعفة 2.2x', 250000000, 'VIP3')
ON CONFLICT DO NOTHING;

-- Add configurable rewards columns to system_config
ALTER TABLE system_config ADD COLUMN IF NOT EXISTS daily_checkin_reward BIGINT DEFAULT 100000; -- Default 0.10 Coinz (100,000 micro-units)
ALTER TABLE system_config ADD COLUMN IF NOT EXISTS banner_click_reward BIGINT DEFAULT 200000;  -- Default 0.20 Coinz (200,000 micro-units)
ALTER TABLE system_config ADD COLUMN IF NOT EXISTS referral_signup_reward BIGINT DEFAULT 100000; -- Default 0.10 Coinz (100,000 micro-units)

-- Re-seed system config defaults to initialize rewards
UPDATE system_config 
SET daily_checkin_reward = COALESCE(daily_checkin_reward, 100000),
    banner_click_reward = COALESCE(banner_click_reward, 200000),
    referral_signup_reward = COALESCE(referral_signup_reward, 100000)
WHERE id = 1;

-- VIP daily claims table (stores daily claimed rewards per subscription lifecycle)
CREATE TABLE IF NOT EXISTS vip_daily_claims (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    claim_date DATE NOT NULL,
    amount BIGINT NOT NULL, -- Stored in micro-units
    claimed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_subscription_claim_date UNIQUE (subscription_id, claim_date)
);

-- One-time tasks definition table
CREATE TABLE IF NOT EXISTS one_time_tasks (
    id SERIAL PRIMARY KEY,
    task_key VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(100) NOT NULL,
    arabic_title VARCHAR(100) NOT NULL,
    url VARCHAR(255) NOT NULL,
    reward_amount BIGINT NOT NULL, -- Stored in micro-units (e.g. 0.10 Coinz = 100,000)
    is_active BOOLEAN DEFAULT TRUE,
    max_reward_claims INTEGER DEFAULT NULL, -- Global cap on claims (e.g. 50,000 users)
    cooldown_seconds INTEGER DEFAULT 15,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- User completed one-time tasks tracking table
CREATE TABLE IF NOT EXISTS user_one_time_tasks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_key VARCHAR(50) NOT NULL REFERENCES one_time_tasks(task_key) ON DELETE CASCADE,
    device_fingerprint VARCHAR(255),
    ip_address VARCHAR(45),
    claimed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_user_one_time_task UNIQUE (user_id, task_key)
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_vip_daily_claims_user ON vip_daily_claims(user_id);
CREATE INDEX IF NOT EXISTS idx_user_one_time_tasks_user ON user_one_time_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_user_one_time_tasks_fingerprint ON user_one_time_tasks(device_fingerprint);

-- Seed initial one-time social tasks
INSERT INTO one_time_tasks (task_key, title, arabic_title, url, reward_amount, max_reward_claims, cooldown_seconds) VALUES
('WHATSAPP', 'Follow official WhatsApp channel', 'متابعة قناة الواتساب الرسمية', 'https://whatsapp.com/channel/example', 100000, 50000, 15),
('TELEGRAM', 'Join official Telegram channel', 'متابعة قناة التليجرام الرسمية', 'https://t.me/example', 100000, 50000, 15),
('FACEBOOK', 'Follow official Facebook page', 'متابعة صفحة الفيسبوك الرسمية', 'https://facebook.com/example', 100000, 50000, 15),
('INSTAGRAM', 'Follow official Instagram account', 'متابعة صفحة الإنستغرام الرسمية', 'https://instagram.com/example', 100000, 50000, 15),
('TIKTOK', 'Follow official TikTok account', 'متابعة حساب تيك توك الرسمي', 'https://tiktok.com/@example', 100000, 50000, 15)
ON CONFLICT (task_key) DO UPDATE
SET reward_amount = EXCLUDED.reward_amount,
    max_reward_claims = EXCLUDED.max_reward_claims,
    cooldown_seconds = EXCLUDED.cooldown_seconds;

-- Dynamic Economy Config Updates
ALTER TABLE system_config ADD COLUMN IF NOT EXISTS coinz_iqd_rate NUMERIC(15,4) DEFAULT 1600.0000;
ALTER TABLE system_config ADD COLUMN IF NOT EXISTS ad_reward_min BIGINT DEFAULT 10000;
ALTER TABLE system_config ADD COLUMN IF NOT EXISTS ad_reward_max BIGINT DEFAULT 20000;
ALTER TABLE system_config ADD COLUMN IF NOT EXISTS vip_daily_claim_duration INTEGER DEFAULT 30;
ALTER TABLE system_config ADD COLUMN IF NOT EXISTS withdrawal_minimum BIGINT DEFAULT 10000000;
ALTER TABLE system_config ADD COLUMN IF NOT EXISTS withdrawal_maximum BIGINT DEFAULT 100000000;
ALTER TABLE system_config ADD COLUMN IF NOT EXISTS withdrawal_fee_percentage NUMERIC(5,2) DEFAULT 0.00;
ALTER TABLE system_config ADD COLUMN IF NOT EXISTS withdrawal_fee_flat BIGINT DEFAULT 0;

-- Set values for new columns if they are null
UPDATE system_config 
SET coinz_iqd_rate = COALESCE(coinz_iqd_rate, 1600.0000),
    ad_reward_min = COALESCE(ad_reward_min, 10000),
    ad_reward_max = COALESCE(ad_reward_max, 20000),
    vip_daily_claim_duration = COALESCE(vip_daily_claim_duration, 30),
    withdrawal_minimum = COALESCE(withdrawal_minimum, 10000000),
    withdrawal_maximum = COALESCE(withdrawal_maximum, 100000000),
    withdrawal_fee_percentage = COALESCE(withdrawal_fee_percentage, 0.00),
    withdrawal_fee_flat = COALESCE(withdrawal_fee_flat, 0)
WHERE id = 1;

-- Create vip_tiers_config table
CREATE TABLE IF NOT EXISTS vip_tiers_config (
    tier VARCHAR(20) PRIMARY KEY CHECK (tier IN ('FREE', 'VIP1', 'VIP2', 'VIP3', 'VIP4', 'VIP5', 'VIP6', 'VIP7', 'VIP8', 'VIP9', 'VIP10')),
    price_usd BIGINT NOT NULL DEFAULT 0,
    multiplier NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    daily_earning_cap BIGINT NOT NULL DEFAULT 1000000,
    daily_ad_limit INTEGER NOT NULL DEFAULT 5
);

-- Seed vip_tiers_config
INSERT INTO vip_tiers_config (tier, price_usd, multiplier, daily_earning_cap, daily_ad_limit) VALUES
('FREE', 0, 0.00, 1000000, 5),
('VIP1', 50000000, 0.05, 2000000, 10),
('VIP2', 100000000, 0.10, 3000000, 20),
('VIP3', 250000000, 0.15, 5000000, 30),
('VIP4', 500000000, 0.20, 7000000, 60),
('VIP5', 1000000000, 0.30, 10000000, 80),
('VIP6', 2000000000, 0.40, 15000000, 100),
('VIP7', 3000000000, 0.50, 20000000, 120),
('VIP8', 5000000000, 0.60, 30000000, 140),
('VIP9', 7500000000, 0.80, 40000000, 160),
('VIP10', 10000000000, 1.00, 50000000, 200)
ON CONFLICT (tier) DO UPDATE SET
    price_usd = EXCLUDED.price_usd,
    multiplier = EXCLUDED.multiplier,
    daily_earning_cap = EXCLUDED.daily_earning_cap,
    daily_ad_limit = EXCLUDED.daily_ad_limit;

-- Create store_orders table
CREATE TABLE IF NOT EXISTS store_orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    category VARCHAR(50) NOT NULL, -- 'CARDS', 'CHAT_COINS', 'GAMES', 'CURRENCY_EXCHANGE'
    product_name VARCHAR(255) NOT NULL,
    coins_price BIGINT NOT NULL, -- Stored in micro-units: 1 Coinz = 1,000,000 micro-units
    details JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    rejection_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'GENERAL',
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


