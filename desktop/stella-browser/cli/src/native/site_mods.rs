use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub type SiteModsMap = BTreeMap<String, SiteMod>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteMod {
    pub css: Option<String>,
    pub js: Option<String>,
    pub label: Option<String>,
    pub enabled: bool,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteModRuleSummary {
    pub pattern: String,
    pub label: Option<String>,
    pub has_css: bool,
    pub has_js: bool,
    pub enabled: bool,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InjectionRule {
    pattern: String,
    css: Option<String>,
    js: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn get_app_dir() -> PathBuf {
    crate::connection::get_storage_root_dir()
}

fn get_store_path() -> PathBuf {
    let dir = get_app_dir();
    let _ = fs::create_dir_all(&dir);
    dir.join("site-mods.json")
}

pub fn get_mods() -> SiteModsMap {
    let file_path = get_store_path();
    if !file_path.exists() {
        return SiteModsMap::new();
    }

    fs::read_to_string(file_path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_mods(mods: &SiteModsMap) -> Result<(), String> {
    let content = serde_json::to_string_pretty(mods)
        .map_err(|e| format!("Failed to serialize site mods: {}", e))?;
    fs::write(get_store_path(), content).map_err(|e| format!("Failed to save site mods: {}", e))
}

pub fn set_mod(
    pattern: &str,
    css: Option<String>,
    js: Option<String>,
    label: Option<String>,
) -> Result<(SiteMod, usize), String> {
    let mut mods = get_mods();
    let existing = mods.get(pattern).cloned();

    let mod_rule = SiteMod {
        css: css.or_else(|| existing.as_ref().and_then(|rule| rule.css.clone())),
        js: js.or_else(|| existing.as_ref().and_then(|rule| rule.js.clone())),
        label: label.or_else(|| existing.as_ref().and_then(|rule| rule.label.clone())),
        enabled: true,
        updated_at: now_ms(),
    };

    mods.insert(pattern.to_string(), mod_rule.clone());
    save_mods(&mods)?;
    Ok((mod_rule, mods.len()))
}

pub fn remove_mod(pattern: &str) -> Result<(bool, usize), String> {
    let mut mods = get_mods();
    let existed = mods.remove(pattern).is_some();
    save_mods(&mods)?;
    Ok((existed, mods.len()))
}

pub fn toggle_mod(pattern: &str, enabled: Option<bool>) -> Result<bool, String> {
    let mut mods = get_mods();
    let rule = mods
        .get_mut(pattern)
        .ok_or_else(|| format!("No site mod found for pattern: {}", pattern))?;
    rule.enabled = enabled.unwrap_or(!rule.enabled);
    rule.updated_at = now_ms();
    let is_enabled = rule.enabled;
    save_mods(&mods)?;
    Ok(is_enabled)
}

pub fn list_rules() -> Vec<SiteModRuleSummary> {
    get_mods()
        .into_iter()
        .map(|(pattern, rule)| SiteModRuleSummary {
            pattern,
            label: rule.label,
            has_css: rule.css.as_ref().is_some_and(|css| !css.is_empty()),
            has_js: rule.js.as_ref().is_some_and(|js| !js.is_empty()),
            enabled: rule.enabled,
            updated_at: rule.updated_at,
        })
        .collect()
}

pub fn build_injection_script(mods: &SiteModsMap) -> Option<String> {
    let rules: Vec<InjectionRule> = mods
        .iter()
        .filter(|(_, rule)| rule.enabled && (rule.css.is_some() || rule.js.is_some()))
        .map(|(pattern, rule)| InjectionRule {
            pattern: pattern.clone(),
            css: rule.css.clone(),
            js: rule.js.clone(),
        })
        .collect();

    if rules.is_empty() {
        return None;
    }

    let rules_json = serde_json::to_string(&rules).ok()?;
    Some(format!(
        r#"
(() => {{
  const rules = {rules_json};
  const getMatchTarget = (url) => {{
    try {{
      const parsed = new URL(url);
      const path = parsed.pathname === '/' ? '' : parsed.pathname;
      return parsed.hostname + path;
    }} catch {{
      return null;
    }}
  }};
  const escapeRegex = (value) => value.replace(/[.+^${{}}()|[\]\\]/g, '\\$&');
  const matchesPattern = (pattern, target) => {{
    const source = '^' + escapeRegex(pattern).replace(/\\\*/g, '.*') + '$';
    return new RegExp(source, 'i').test(target);
  }};

  const target = getMatchTarget(location.href);
  if (!target) return;

  const applied = window.__stellaSiteModsApplied || (window.__stellaSiteModsApplied = {{}});
  const head = document.head || document.documentElement;

  rules.forEach((rule, index) => {{
    if (!matchesPattern(rule.pattern, target)) return;

    if (rule.css && head) {{
      const styleId = `stella-site-mod-${{index}}`;
      if (!document.getElementById(styleId)) {{
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = rule.css;
        head.appendChild(style);
      }}
    }}

    if (rule.js && !applied[rule.pattern]) {{
      applied[rule.pattern] = true;
      (0, eval)(rule.js);
    }}
  }});
}})();
"#
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::EnvGuard;
    use std::fs;

    fn make_temp_runtime_dir(test_name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("stella-browser-site-mods-{}", test_name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_set_list_toggle_remove_mod() {
        let temp_dir = make_temp_runtime_dir("crud");
        let temp_dir_str = temp_dir.to_string_lossy().to_string();
        let guard = EnvGuard::new(&["XDG_RUNTIME_DIR"]);
        guard.set("XDG_RUNTIME_DIR", &temp_dir_str);

        let (created, total) = set_mod(
            "example.com/*",
            Some("body { color: red; }".to_string()),
            None,
            Some("Example".to_string()),
        )
        .unwrap();
        assert_eq!(total, 1);
        assert_eq!(created.label.as_deref(), Some("Example"));
        assert!(created.enabled);

        let rules = list_rules();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].pattern, "example.com/*");
        assert!(rules[0].has_css);
        assert!(!rules[0].has_js);

        let enabled = toggle_mod("example.com/*", Some(false)).unwrap();
        assert!(!enabled);

        let (removed, remaining) = remove_mod("example.com/*").unwrap();
        assert!(removed);
        assert_eq!(remaining, 0);
    }

    #[test]
    fn test_build_injection_script_contains_rules() {
        let mut mods = SiteModsMap::new();
        mods.insert(
            "example.com/*".to_string(),
            SiteMod {
                css: Some("body { color: red; }".to_string()),
                js: Some("console.log('hi')".to_string()),
                label: None,
                enabled: true,
                updated_at: 1,
            },
        );

        let script = build_injection_script(&mods).unwrap();
        assert!(script.contains("example.com/*"));
        assert!(script.contains("__stellaSiteModsApplied"));
    }
}
