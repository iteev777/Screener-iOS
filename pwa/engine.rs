// SPDX-License-Identifier: BUSL-1.1
#[allow(dead_code)]
#[path = "../src/strategies/conditions/indicators.rs"]
mod indicators;

const WINDOW: usize = 16;

#[no_mangle]
pub extern "C" fn signal(oldest: f64, older: f64, previous: f64, price: f64) -> i32 {
    let prices = [oldest, older, previous, price];
    if prices.iter().any(|p| !p.is_finite() || *p <= 0.0) {
        return 0;
    }
    match indicators::rsi(&prices, 3) {
        Some(rsi) if rsi < 35.0 => 1,
        Some(rsi) if rsi > 65.0 => -1,
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn benchmark(rounds: u32) -> f64 {
    let prices = [1.0; WINDOW];
    let mut total = 0.0;
    for _ in 0..rounds.min(100_000) {
        total += indicators::rsi(std::hint::black_box(&prices), 14).unwrap_or_default();
    }
    total
}

const MAX_SAMPLES: usize = 64;
static mut CLOSES: [f64; MAX_SAMPLES] = [0.0; MAX_SAMPLES];
static mut AUX: [[f64; MAX_SAMPLES]; 2] = [[0.0; MAX_SAMPLES]; 2];

#[no_mangle]
pub extern "C" fn aux_buffer(index: usize) -> *mut f64 {
    if index >= 2 {
        return std::ptr::null_mut();
    }
    (&raw mut AUX)
        .cast::<f64>()
        .wrapping_add(index * MAX_SAMPLES)
}

#[no_mangle]
pub extern "C" fn sample_buffer() -> *mut f64 {
    (&raw mut CLOSES).cast()
}

#[no_mangle]
pub extern "C" fn entry(count: usize, strategy: u32) -> i32 {
    if !(4..=MAX_SAMPLES).contains(&count) {
        return 0;
    }
    // The browser writes the buffer and calls this export synchronously on one thread.
    let prices = unsafe { std::slice::from_raw_parts((&raw const CLOSES).cast::<f64>(), count) };
    evaluate_entry(prices, strategy)
}

fn evaluate_entry(prices: &[f64], strategy: u32) -> i32 {
    if prices
        .iter()
        .any(|price| !price.is_finite() || *price <= 0.0)
    {
        return 0;
    }
    match strategy {
        0 => match indicators::rsi(&prices[prices.len() - 4..], 3) {
            Some(value) if value < 35.0 => 1,
            Some(value) if value > 65.0 => -1,
            _ => 0,
        },
        1 if prices.len() >= 17 => {
            let fast = indicators::ema(prices, 5);
            let slow = indicators::ema(prices, 16);
            let (a, b) = (fast.len(), slow.len());
            if fast[a - 2] <= slow[b - 2] && fast[a - 1] > slow[b - 1] {
                1
            } else if fast[a - 2] >= slow[b - 2] && fast[a - 1] < slow[b - 1] {
                -1
            } else {
                0
            }
        }
        2 if prices.len() >= 21 => {
            let (last, history) = prices.split_last().unwrap();
            let range = &history[history.len() - 20..];
            if range.iter().all(|previous| last > previous) {
                1
            } else if range.iter().all(|previous| last < previous) {
                -1
            } else {
                0
            }
        }
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn exit(
    price: f64,
    average: f64,
    peak: f64,
    held: f64,
    stop: f64,
    profit: f64,
    trailing: f64,
    break_even: f64,
    max_hold: f64,
    strategy: i32,
) -> u32 {
    if [price, average, peak]
        .iter()
        .any(|p| !p.is_finite() || *p <= 0.0)
    {
        return 0;
    }
    let change = 100.0 * (price - average) / average;
    let peak_change = 100.0 * (peak - average) / average;
    if change <= -stop {
        1
    } else if break_even > 0.0 && peak_change >= break_even && change <= 0.0 {
        2
    } else if trailing > 0.0 && peak > average && 100.0 * (peak - price) / peak >= trailing {
        3
    } else if held >= max_hold {
        4
    } else if change + 1e-9 >= profit {
        5
    } else if strategy == -1 {
        6
    } else {
        0
    }
}

#[cfg(test)]
mod browser_tests {
    use super::*;

    #[test]
    fn selectable_entries_respect_history_and_crossings() {
        let mut prices = [1.0; 21];
        prices[20] = 2.0;
        assert_eq!(evaluate_entry(&prices, 1), 1);
        assert_eq!(evaluate_entry(&prices, 2), 1);
        prices[20] = 0.5;
        assert_eq!(evaluate_entry(&prices, 2), -1);
        assert_eq!(evaluate_entry(&prices[..20], 2), 0);
        prices[0] = f64::NAN;
        assert_eq!(evaluate_entry(&prices, 1), 0);
    }

    #[test]
    fn risk_exits_take_precedence_over_strategy() {
        let decide = |price, peak, held, strategy| {
            exit(
                price, 100.0, peak, held, 5.0, 10.0, 5.0, 5.0, 900.0, strategy,
            )
        };
        assert_eq!(decide(95.0, 112.0, 900.0, -1), 1);
        assert_eq!(decide(100.0, 106.0, 0.0, 0), 2);
        assert_eq!(decide(105.0, 112.0, 0.0, 0), 3);
        assert_eq!(decide(104.0, 104.0, 900.0, 0), 4);
        assert_eq!(decide(110.0, 110.0, 0.0, -1), 5);
        assert_eq!(decide(101.0, 101.0, 0.0, -1), 6);
        assert_eq!(decide(f64::INFINITY, 101.0, 0.0, -1), 0);
    }
}

#[no_mangle]
pub extern "C" fn indicator(kind: u32, count: usize, period: usize) -> f64 {
    if count > MAX_SAMPLES || !(1..=count).contains(&period) {
        return f64::NAN;
    }
    // As with entry(), JS writes and consumes this buffer synchronously.
    let values = unsafe { std::slice::from_raw_parts((&raw const CLOSES).cast::<f64>(), count) };
    if values.iter().any(|value| !value.is_finite()) {
        return f64::NAN;
    }
    let recent = &values[count - period..];
    // JS only supplies auxiliary values for these indicators.
    let auxiliary = |index| unsafe { std::slice::from_raw_parts(aux_buffer(index), count) };
    match kind {
        0 => indicators::sma(recent, period).last().copied(),
        1 => indicators::ema(values, period).last().copied(),
        2 => indicators::rsi(values, period),
        3 => indicators::stddev_population(recent),
        4 => indicators::vwap(recent, &auxiliary(0)[count - period..]),
        5 => indicators::atr(auxiliary(0), auxiliary(1), values, period),
        _ => None,
    }
    .unwrap_or(f64::NAN)
}

/// Whether the requested fast/slow crossing occurred in the selected candle window.
#[no_mangle]
pub extern "C" fn ma_cross(
    count: usize,
    fast_period: usize,
    slow_period: usize,
    within: usize,
    exponential: u32,
    bullish: u32,
) -> f64 {
    if count > MAX_SAMPLES
        || fast_period == 0
        || slow_period <= fast_period
        || within == 0
        || slow_period > count
        || within > count - slow_period
    {
        return f64::NAN;
    }
    let prices = unsafe { std::slice::from_raw_parts((&raw const CLOSES).cast::<f64>(), count) };
    if prices
        .iter()
        .any(|price| !price.is_finite() || *price <= 0.0)
    {
        return f64::NAN;
    }
    let average = if exponential == 1 {
        indicators::ema
    } else {
        indicators::sma
    };
    let fast = average(prices, fast_period);
    let slow = average(prices, slow_period);
    for index in (count - within..count).rev() {
        let (fast_now, fast_before) = (fast[index + 1 - fast_period], fast[index - fast_period]);
        let (slow_now, slow_before) = (slow[index + 1 - slow_period], slow[index - slow_period]);
        let crossed = if bullish == 1 {
            fast_before <= slow_before && fast_now > slow_now
        } else {
            fast_before >= slow_before && fast_now < slow_now
        };
        if crossed {
            return 1.0;
        }
    }
    0.0
}
