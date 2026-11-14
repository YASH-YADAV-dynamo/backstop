//! Pure policy checks: the user's limits and the rolling UTC-day budget.

use near_sdk::json_types::U128;
use near_sdk::near;

pub const SECS_PER_DAY: u64 = 86_400;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub trigger_hf_bps: u32,
    pub target_hf_bps: u32,
    /// USDC, 6 decimals.
    pub max_per_rescue: U128,
    /// USDC, 6 decimals, per UTC day.
    pub daily_cap: U128,
    pub cooldown_secs: u64,
    /// wei; cap on the Base tx `maxFeePerGas`.
    pub max_fee_per_gas: U128,
    /// cap on the Base tx gas limit.
    pub max_gas_limit: U128,
}

impl Limits {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.target_hf_bps <= self.trigger_hf_bps {
            return Err("ERR_TARGET_HF_NOT_ABOVE_TRIGGER");
        }
        if self.max_per_rescue.0 == 0 {
            return Err("ERR_MAX_PER_RESCUE_ZERO");
        }
        if self.max_per_rescue.0 > self.daily_cap.0 {
            return Err("ERR_MAX_PER_RESCUE_ABOVE_DAILY_CAP");
        }
        if self.max_fee_per_gas.0 == 0 {
            return Err("ERR_MAX_FEE_PER_GAS_ZERO");
        }
        if self.max_gas_limit.0 == 0 {
            return Err("ERR_MAX_GAS_LIMIT_ZERO");
        }
        if self.cooldown_secs == 0 {
            return Err("ERR_COOLDOWN_ZERO");
        }
        Ok(())
    }
}

/// Start (unix secs) of the UTC day containing `now`.
pub fn utc_day_start(now: u64) -> u64 {
    now - now % SECS_PER_DAY
}

/// Spending state that the limits are checked against. Used twice: once for rescues and once
/// for bridges (`last_rescue_at` is then the time of the last bridge).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Budget {
    pub spent_today: u128,
    pub day_start: u64,
    pub last_rescue_at: Option<u64>,
}

impl Budget {
    /// The budget as seen at `now`: a new UTC day resets `spent_today`.
    pub fn at(&self, now: u64) -> Budget {
        if now >= self.day_start + SECS_PER_DAY {
            Budget { spent_today: 0, day_start: utc_day_start(now), last_rescue_at: self.last_rescue_at }
        } else {
            self.clone()
        }
    }

    pub fn cooldown_ends_at(&self, cooldown_secs: u64) -> Option<u64> {
        self.last_rescue_at.map(|t| t.saturating_add(cooldown_secs))
    }
}

/// What the agent asks for in one rescue.
pub struct RescueRequest {
    pub amount: u128,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub gas_limit: u128,
}

/// Fee and gas caps shared by every transaction the policy signs.
pub fn check_tx_params(limits: &Limits, req: &RescueRequest) -> Result<(), &'static str> {
    if req.max_fee_per_gas > limits.max_fee_per_gas.0 {
        return Err("ERR_FEE_ABOVE_CAP");
    }
    if req.max_priority_fee_per_gas > req.max_fee_per_gas {
        return Err("ERR_PRIORITY_FEE_ABOVE_MAX_FEE");
    }
    if req.gas_limit > limits.max_gas_limit.0 {
        return Err("ERR_GAS_LIMIT_ABOVE_CAP");
    }
    Ok(())
}

fn check_amount(limits: &Limits, paused: bool, amount: u128) -> Result<(), &'static str> {
    if paused {
        return Err("ERR_PAUSED");
    }
    if amount == 0 {
        return Err("ERR_ZERO_AMOUNT");
    }
    if amount > limits.max_per_rescue.0 {
        return Err("ERR_OVER_MAX_PER_RESCUE");
    }
    Ok(())
}

/// Cooldown and daily cap; on success the budget after spending `amount` at `now`.
fn spend(limits: &Limits, budget: &Budget, now: u64, amount: u128) -> Result<Budget, &'static str> {
    let current = budget.at(now);
    if let Some(ends) = current.cooldown_ends_at(limits.cooldown_secs) {
        if now < ends {
            return Err("ERR_COOLDOWN");
        }
    }
    let spent = current.spent_today.checked_add(amount).ok_or("ERR_OVER_DAILY_CAP")?;
    if spent > limits.daily_cap.0 {
        return Err("ERR_OVER_DAILY_CAP");
    }
    Ok(Budget { spent_today: spent, day_start: current.day_start, last_rescue_at: Some(now) })
}

/// Checks one rescue against the limits. On success returns the budget after spending.
pub fn check_rescue(
    limits: &Limits,
    paused: bool,
    budget: &Budget,
    now: u64,
    req: &RescueRequest,
) -> Result<Budget, &'static str> {
    check_amount(limits, paused, req.amount)?;
    check_tx_params(limits, req)?;
    spend(limits, budget, now, req.amount)
}

/// Checks one bridge (USDC paid to 1Click) against the same limits, on its own budget.
pub fn check_bridge(limits: &Limits, paused: bool, budget: &Budget, now: u64, amount: u128) -> Result<Budget, &'static str> {
    check_amount(limits, paused, amount)?;
    spend(limits, budget, now, amount)
}
