//! Input blob fetcher .
//!
//! Resolves a job's `inputRef` to the input bytes the sandbox runs over. Supports
//! `http(s)://` directly and `ipfs://<cid>` via a configurable gateway. A size cap
//! guards against a hostile/oversized blob. The bytes are hashed into the proof's
//! `inputHash`, so integrity is attested downstream — but the fetcher itself does
//! not verify the blob against any expected hash (that binding is a later step).

#[derive(Debug)]
pub enum FetchError {
    /// The `inputRef` scheme isn't one we can fetch.
    Unsupported(String),
    /// Network error, non-2xx status, or the blob exceeded the size cap.
    Http(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Unsupported(m) => write!(f, "fetch: {m}"),
            FetchError::Http(m) => write!(f, "fetch http: {m}"),
        }
    }
}

impl std::error::Error for FetchError {}

/// Default public IPFS gateway; override the host as deployments require.
pub const DEFAULT_IPFS_GATEWAY: &str = "https://ipfs.io/ipfs/";

/// Map an `inputRef` to an absolute HTTP(S) URL to GET.
fn resolve_url(input_ref: &str, ipfs_gateway: &str) -> Result<String, FetchError> {
    if let Some(cid) = input_ref.strip_prefix("ipfs://") {
        Ok(format!("{}{}", ipfs_gateway, cid.trim_start_matches('/')))
    } else if input_ref.starts_with("http://") || input_ref.starts_with("https://") {
        Ok(input_ref.to_string())
    } else {
        Err(FetchError::Unsupported(format!(
            "unsupported inputRef scheme: {input_ref}"
        )))
    }
}

/// Fetch the input bytes for `input_ref`, rejecting blobs larger than `max_bytes`.
pub async fn fetch_input(
    input_ref: &str,
    ipfs_gateway: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, FetchError> {
    let url = resolve_url(input_ref, ipfs_gateway)?;
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| FetchError::Http(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(FetchError::Http(format!("GET {url} -> {}", resp.status())));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| FetchError::Http(e.to_string()))?;
    if bytes.len() > max_bytes {
        return Err(FetchError::Http(format!(
            "input {} bytes exceeds cap {max_bytes}",
            bytes.len()
        )));
    }
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_ipfs_to_gateway() {
        assert_eq!(
            resolve_url("ipfs://Qm123/file", DEFAULT_IPFS_GATEWAY).unwrap(),
            "https://ipfs.io/ipfs/Qm123/file"
        );
        // leading slash after the scheme is tolerated
        assert_eq!(
            resolve_url("ipfs:///Qm123", "https://gw/ipfs/").unwrap(),
            "https://gw/ipfs/Qm123"
        );
    }

    #[test]
    fn passes_http_through() {
        let u = "https://example.com/blob";
        assert_eq!(resolve_url(u, DEFAULT_IPFS_GATEWAY).unwrap(), u);
        assert_eq!(
            resolve_url("http://h/x", DEFAULT_IPFS_GATEWAY).unwrap(),
            "http://h/x"
        );
    }

    #[test]
    fn rejects_unknown_scheme() {
        assert!(matches!(
            resolve_url("s3://bucket/key", DEFAULT_IPFS_GATEWAY),
            Err(FetchError::Unsupported(_))
        ));
        assert!(matches!(
            resolve_url("file:///etc/passwd", DEFAULT_IPFS_GATEWAY),
            Err(FetchError::Unsupported(_))
        ));
    }
}
