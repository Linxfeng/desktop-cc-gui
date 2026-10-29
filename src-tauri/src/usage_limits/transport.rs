//! HTTP seam for the limits lookup. Production goes through reqwest; tests
//! swap in a scripted fake so parsing, status mapping, backoff and caching
//! are exercised without the network.

use std::sync::OnceLock;
use std::time::Duration;

use futures_util::future::BoxFuture;

/// Short enough that a stalled vendor never holds the limits page for long.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Usage bodies are a few KB; anything larger is not the response we expect.
const MAX_BODY_BYTES: usize = 1024 * 1024;
const USER_AGENT: &str = concat!("CCGUI/", env!("CARGO_PKG_VERSION"));

/// One GET against a vendor endpoint. `url` is always one of the fixed
/// endpoint constants, never caller input. Header values may carry bearer
/// tokens, so `Debug` prints header names only.
pub(crate) struct HttpRequest {
    pub url: &'static str,
    pub headers: Vec<(&'static str, String)>,
}

impl std::fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<&str> = self.headers.iter().map(|(name, _)| *name).collect();
        f.debug_struct("HttpRequest")
            .field("url", &self.url)
            .field("headers", &names)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HttpOutcome {
    /// The server answered. `body` is only read for 2xx responses (empty
    /// otherwise, or when it exceeded the size cap).
    Response {
        status: u16,
        body: String,
        retry_after_secs: Option<u64>,
    },
    /// DNS, connect, TLS, timeout, or the connection dropped mid-body.
    Network,
}

pub(crate) trait LimitsHttp: Send + Sync {
    fn get<'a>(&'a self, request: &'a HttpRequest) -> BoxFuture<'a, HttpOutcome>;
}

/// Production transport. The client is built on the first request of a
/// lookup round (rounds served from cache never build one), and per round
/// rather than once per process: reqwest snapshots HTTP(S)_PROXY at build
/// time, and `proxy.rs` rewrites that env when the user toggles the proxy.
pub(crate) struct ReqwestHttp {
    client: OnceLock<Option<reqwest::Client>>,
}

impl ReqwestHttp {
    pub(crate) fn new() -> Self {
        Self {
            client: OnceLock::new(),
        }
    }

    fn client(&self) -> Option<&reqwest::Client> {
        self.client
            .get_or_init(|| {
                reqwest::Client::builder()
                    .connect_timeout(CONNECT_TIMEOUT)
                    .timeout(REQUEST_TIMEOUT)
                    .user_agent(USER_AGENT)
                    // Never follow a redirect: the bearer token must only
                    // ever reach the vendor's own API host.
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .ok()
            })
            .as_ref()
    }
}

impl LimitsHttp for ReqwestHttp {
    fn get<'a>(&'a self, request: &'a HttpRequest) -> BoxFuture<'a, HttpOutcome> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return HttpOutcome::Network;
            };
            let mut builder = client.get(request.url);
            for (name, value) in &request.headers {
                builder = builder.header(*name, value.as_str());
            }
            let Ok(response) = builder.send().await else {
                return HttpOutcome::Network;
            };
            let status = response.status().as_u16();
            let retry_after_secs = parse_retry_after(response.headers());
            if !response.status().is_success() {
                return HttpOutcome::Response {
                    status,
                    body: String::new(),
                    retry_after_secs,
                };
            }
            match read_body_capped(response).await {
                Some(body) => HttpOutcome::Response {
                    status,
                    body,
                    retry_after_secs,
                },
                None => HttpOutcome::Network,
            }
        })
    }
}

/// Delta-seconds form only; an HTTP-date Retry-After falls back to the
/// fixed backoff schedule.
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|secs| *secs > 0)
}

/// `None` when the stream broke (treated as a network failure). An oversized
/// body yields an empty string, which the parsers reject as unexpected.
async fn read_body_capped(mut response: reqwest::Response) -> Option<String> {
    let mut bytes: Vec<u8> = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len() + chunk.len() > MAX_BODY_BYTES {
                    return Some(String::new());
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => return Some(String::from_utf8_lossy(&bytes).into_owned()),
            Err(_) => return None,
        }
    }
}
