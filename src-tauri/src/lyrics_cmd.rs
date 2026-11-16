use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::redirect;
use serde::Serialize;

#[derive(Serialize)]
pub struct HttpResp {
    status: u16,
    body: String,
}

// Разрешённые хосты — чтобы страница не могла использовать команду как открытый прокси
const ALLOWED_HOSTS: &[&str] = &["lrclib.net", "genius.com"];

// Ответы больше этого размера не отдаём в страницу (страница Genius ~ сотни КБ)
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

fn is_allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| ALLOWED_HOSTS.contains(&host))
}

// Один клиент на всё приложение — переиспользует соединения и TLS-сессии
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let c = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        )
        // редиректы тоже только на разрешённые хосты, иначе белый список легко обойти
        .redirect(redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if is_allowed(attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| c))
}

#[tauri::command]
pub async fn http_get(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<HttpResp, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if !is_allowed(&parsed) {
        return Err(format!(
            "url not allowed: {}",
            parsed.host_str().unwrap_or_default()
        ));
    }

    let mut req = client()?.get(parsed);
    for (k, v) in headers.unwrap_or_default() {
        req = req.header(k, v);
    }

    let mut res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();

    let mut buf = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > MAX_BODY_BYTES {
            return Err("response too large".into());
        }
        buf.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&buf).into_owned();
    Ok(HttpResp { status, body })
}
