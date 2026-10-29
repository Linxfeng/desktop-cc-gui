use super::Scratch;
use crate::usage_stats::pricing::{
    build_cache_text, compact_litellm, load_preferred, parse_snapshot, PriceTable,
};
use crate::usage_stats::types::Tokens;
use serde_json::json;

fn table() -> PriceTable {
    parse_snapshot(
        r#"{"source":"litellm","snapshotDate":"2026-10-01","models":{
            "claude-opus-4-5": [0.000005, 0.000025, 5e-7, 0.00000625],
            "claude-opus-4": [0.000015, 0.000075, null, null],
            "claude-haiku-4-5": [0.000001, 0.000005, 1e-7, 0.00000125],
            "gpt-5": [0.00000125, 0.00001, 1.25e-7, null],
            "gpt-5.6-sol": [0.000004, 0.00002, 4e-7, null],
            "azure_ai/deepseek-v4-flash": [0.000009, 0.000009, null, null],
            "deepseek/deepseek-v4-flash": [3e-7, 0.0000012, 3e-8, null],
            "Mixed-Case-Model": [0.000001, 0.000002, null, null],
            "no-output-price": [0.000001, null, null, null]
        }}"#,
        "bundled",
        None,
    )
    .unwrap()
}

#[test]
fn matcher_walks_the_documented_fallbacks() {
    let t = table();
    let cases = [
        ("gpt-5", Some("gpt-5")), // exact
        ("GPT-5", Some("gpt-5")), // lowercase
        ("mixed-case-model", Some("Mixed-Case-Model")),
        ("anthropic/claude-opus-4-5", Some("claude-opus-4-5")), // provider prefix
        (
            "openrouter/anthropic/claude-opus-4-5",
            Some("claude-opus-4-5"),
        ),
        ("claude-haiku-4-5-20251001", Some("claude-haiku-4-5")), // date suffix
        ("claude-opus-4-5@20251101", Some("claude-opus-4-5")),
        ("claude-opus-4-5[1m]", Some("claude-opus-4-5")),
        ("claude-opus-4.5", Some("claude-opus-4-5")), // dotted Claude version
        ("deepseek-v4-flash", Some("deepseek/deepseek-v4-flash")), // provider-prefixed key
        ("gpt-5.6-sol-high", Some("gpt-5.6-sol")),    // longest prefix
        ("claude-opus-4-5-thinking", Some("claude-opus-4-5")),
        ("gpt-5-high", Some("gpt-5")), // reasoning-effort mode of the same model
        ("gpt-5-turbo", None),          // a different model: never borrow gpt-5's price
        ("gpt-5-spark", None),
        ("gpt-5-pro", None),
        ("claude-opus-4-9", None), // never a numeric cut
        ("gpt-5.9", None),
        ("k3.1-pro", None),
        ("no-output-price", None),
        ("unknown", None),
        ("", None),
    ];
    for (model, expected) in cases {
        assert_eq!(t.resolve(model).as_deref(), expected, "{model}");
    }
}

#[test]
fn cost_uses_cache_prices_and_falls_back_to_input() {
    let t = table();
    let tokens = Tokens {
        input: 1000,
        output: 100,
        cache_read: 10_000,
        cache_write: 2000,
        reasoning: 50,
    };
    let opus = t.price("claude-opus-4-5").unwrap().cost(&tokens);
    let expected = 1000.0 * 0.000005 + 100.0 * 0.000025 + 10_000.0 * 5e-7 + 2000.0 * 0.00000625;
    assert!(
        (opus - expected).abs() < 1e-12,
        "reasoning is inside output, never billed twice"
    );
    let old = t.price("claude-opus-4").unwrap().cost(&tokens);
    let expected_old = 1000.0 * 0.000015 + 100.0 * 0.000075 + 12_000.0 * 0.000015;
    assert!((old - expected_old).abs() < 1e-12);
    assert_eq!(t.price("mystery-model"), None);
    assert_eq!(t.price("mystery-model"), None, "cached negative lookup");
}

#[test]
fn bundled_snapshot_prices_the_engines_models() {
    let scratch = Scratch::new("prices-bundled");
    let t = load_preferred(&scratch.path("absent.json"));
    let info = t.info();
    assert_eq!(info.source, "bundled");
    assert_eq!(info.updated_at, None);
    assert!(info.models > 1000, "{} models", info.models);
    for model in [
        "claude-opus-4-5",
        "claude-sonnet-4-5-20250929",
        "gpt-5-codex",
        "gpt-5.1-codex",
        "deepseek-v4-flash",
    ] {
        assert!(t.price(model).is_some(), "{model} should be priced");
    }
    // Variants missing from the snapshot stay unpriced instead of borrowing
    // their base model's price (found by review against the real table).
    for model in ["kimi-k2-turbo", "qwen3-coder-plus", "gpt-5.3-codex-spark"] {
        let resolved = t.resolve(model);
        assert!(
            resolved.as_deref().is_none_or(|id| id.to_lowercase().ends_with(model)),
            "{model} must not borrow another model's price (got {resolved:?})"
        );
    }
}

fn litellm_fixture(extra: usize) -> serde_json::Value {
    let mut raw = json!({
        "sample_spec": {"mode": "chat", "input_cost_per_token": 0.0, "output_cost_per_token": 0.0},
        "chat-model": {"mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 2e-6,
                       "cache_read_input_token_cost": 1e-7, "cache_creation_input_token_cost": 1.25e-6,
                       "max_tokens": 1000},
        "codex-model": {"mode": "responses", "input_cost_per_token": 1e-6, "output_cost_per_token": 2e-6},
        "embed-model": {"mode": "embedding", "input_cost_per_token": 1e-7, "output_cost_per_token": 0.0},
        "free-model": {"mode": "chat", "input_cost_per_token": 0.0, "output_cost_per_token": 0.0},
        "no-output": {"mode": "chat", "input_cost_per_token": 1e-6},
        "fireworks_ai/accounts/fireworks/models/x": {"mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6},
        "provider/model": {"mode": "completion", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6},
    });
    for i in 0..extra {
        raw[format!("filler-{i}")] =
            json!({"mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6});
    }
    raw
}

#[test]
fn litellm_filter_keeps_priced_text_models_only() {
    let models = compact_litellm(&litellm_fixture(0));
    let ids: Vec<&str> = models.keys().map(String::as_str).collect();
    assert_eq!(ids, ["chat-model", "codex-model", "provider/model"]);
    assert_eq!(
        models["chat-model"],
        [Some(1e-6), Some(2e-6), Some(1e-7), Some(1.25e-6)]
    );
    assert_eq!(models["codex-model"], [Some(1e-6), Some(2e-6), None, None]);
    assert!(
        build_cache_text(&litellm_fixture(0), "2026-10-28").is_err(),
        "too few models"
    );
    let text = build_cache_text(&litellm_fixture(120), "2026-10-28").unwrap();
    let parsed = parse_snapshot(&text, "online", Some(1)).unwrap();
    assert_eq!(parsed.info().models, 123);
    assert_eq!(parsed.info().snapshot_date, "2026-10-28");
}

#[test]
fn newer_online_copy_wins_over_the_bundled_snapshot() {
    let scratch = Scratch::new("prices-online");
    let path = scratch.path("model-prices.json");
    std::fs::write(
        &path,
        build_cache_text(&litellm_fixture(120), "2999-01-01").unwrap(),
    )
    .unwrap();
    let online = load_preferred(&path).info();
    assert_eq!((online.source.as_str(), online.models), ("online", 123));
    assert!(online.updated_at.is_some());

    std::fs::write(
        &path,
        build_cache_text(&litellm_fixture(120), "2001-01-01").unwrap(),
    )
    .unwrap();
    assert_eq!(
        load_preferred(&path).info().source,
        "bundled",
        "older copy loses"
    );

    std::fs::write(&path, "{ not json").unwrap();
    assert_eq!(
        load_preferred(&path).info().source,
        "bundled",
        "corrupt copy ignored"
    );
}
