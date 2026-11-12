//! The `fwart:` scheme: a script-free page that shows one remote image.
//!
//! Asset artwork comes from whatever host an asset's issuer chose, and the
//! wallet page's own policy only lets it load images from a short list of
//! origins. Artwork from any other https host is shown in a frame instead:
//! the page frames `fwart://localhost/view?src=<https URL>` with an empty
//! `sandbox` attribute (no scripts, no forms, no popups, opaque origin), and
//! this handler answers with an `<img>` of that URL under its own policy, which
//! allows https images and nothing else. Even if a remote SVG or a crafted URL
//! got past the checks here, there is nothing in the frame that can run script
//! or reach the wallet page.

use std::borrow::Cow;

use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::Url;

pub const SCHEME: &str = "fwart";

/// The viewer's policy: https images, inline styles for its one style block,
/// and nothing else. frame-ancestors keeps it from being framed by anything
/// but the wallet page.
pub const VIEWER_POLICY: &str = "default-src 'none'; img-src https:; style-src 'unsafe-inline'; \
base-uri 'none'; form-action 'none'; frame-ancestors tauri://localhost";

const ERROR_POLICY: &str = "default-src 'none'; frame-ancestors tauri://localhost";

/// Longest image URL the viewer accepts.
const MAX_SRC_LEN: usize = 4096;

/// The image URL the request asks for, if it is one the viewer shows: a GET of
/// `fwart://localhost/view` with exactly one `src` parameter holding an
/// absolute https URL with a host.
pub fn image_src(method: &Method, uri: &str) -> Result<Url, &'static str> {
    if method != Method::GET {
        return Err("method");
    }
    let url = Url::parse(uri).map_err(|_| "uri")?;
    if url.scheme() != SCHEME || url.host_str() != Some("localhost") || url.path() != "/view" {
        return Err("path");
    }
    let mut pairs = url.query_pairs();
    let src = match (pairs.next(), pairs.next()) {
        (Some((k, v)), None) if k == "src" => v.into_owned(),
        _ => return Err("query"),
    };
    if src.len() > MAX_SRC_LEN {
        return Err("length");
    }
    let src = Url::parse(&src).map_err(|_| "src")?;
    if src.scheme() != "https" || src.host_str().map_or(true, str::is_empty) {
        return Err("scheme");
    }
    Ok(src)
}

fn escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

pub fn viewer_html(src: &Url) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\">\
<style>html,body{{margin:0;height:100%;background:transparent}}\
img{{display:block;width:100%;height:100%;object-fit:contain}}</style></head>\
<body><img src=\"{}\" alt=\"\" referrerpolicy=\"no-referrer\"></body></html>",
        escape_attr(src.as_str())
    )
}

fn respond(status: StatusCode, policy: &str, mime: &str, body: String) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_SECURITY_POLICY, policy)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(body.into_bytes()))
        .expect("static response parts are valid")
}

pub fn handle(request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    match image_src(request.method(), &request.uri().to_string()) {
        Ok(src) => respond(StatusCode::OK, VIEWER_POLICY, "text/html; charset=utf-8", viewer_html(&src)),
        Err(why) => respond(StatusCode::BAD_REQUEST, ERROR_POLICY, "text/plain; charset=utf-8", format!("refused: {why}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(uri: &str) -> Result<String, &'static str> {
        image_src(&Method::GET, uri).map(|u| u.to_string())
    }

    fn view(target: &str) -> String {
        let q: String = tauri::Url::parse_with_params("fwart://localhost/view", &[("src", target)]).unwrap().into();
        q
    }

    #[test]
    fn accepts_https_images_only() {
        assert_eq!(src(&view("https://ipfs.io/ipfs/bafy/a.png")).unwrap(), "https://ipfs.io/ipfs/bafy/a.png");
        assert_eq!(src(&view("  HTTPS://Example.COM/x.svg")).unwrap(), "https://example.com/x.svg");
        for bad in [
            "http://example.com/a.png",
            "javascript:alert(1)",
            "data:image/svg+xml,<svg onload=alert(1)>",
            "file:///etc/passwd",
            "fwart://localhost/view?src=https://x/",
            "tauri://localhost/index.html",
            "https://",
            "https://:443/a.png",
            "//example.com/a.png",
            "",
        ] {
            assert!(src(&view(bad)).is_err(), "accepted {bad:?}");
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_SRC_LEN));
        assert_eq!(src(&view(&long)), Err("length"));
    }

    #[test]
    fn only_get_of_the_view_path_with_one_src() {
        let ok = view("https://example.com/a.png");
        assert!(image_src(&Method::POST, &ok).is_err());
        assert_eq!(src(&ok.replace("/view", "/other")), Err("path"));
        assert_eq!(src(&ok.replace("localhost", "evil")), Err("path"));
        assert_eq!(src("fwart://localhost/view"), Err("query"));
        assert_eq!(src(&(ok.clone() + "&src=https://other.example/b.png")), Err("query"));
        assert_eq!(src(&ok.replace("src=", "img=")), Err("query"));
    }

    #[test]
    fn the_page_escapes_the_url_and_has_no_script() {
        // A quote that survives URL parsing must not end the attribute.
        let u = Url::parse("https://example.com/a'b\"c<d>.png").unwrap();
        let html = viewer_html(&u);
        let attr = html.split("<img src=\"").nth(1).unwrap().split('"').next().unwrap();
        assert!(attr.starts_with("https://example.com/a"), "{html}");
        assert!(attr.ends_with(".png"), "attribute ended early: {html}");
        assert!(!attr.contains(['\'', '<', '>']), "{attr}");
        assert!(!html.to_ascii_lowercase().contains("<script"));
        assert!(!html.contains(" on"));
    }

    #[test]
    fn responses_carry_the_policy() {
        let req = Request::builder().uri(view("https://example.com/a.png")).body(Vec::new()).unwrap();
        let res = handle(&req);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CONTENT_SECURITY_POLICY], VIEWER_POLICY);
        assert_eq!(res.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        let body = String::from_utf8(res.body().to_vec()).unwrap();
        assert!(body.contains("<img src=\"https://example.com/a.png\""));

        let req = Request::builder().uri(view("http://example.com/a.png")).body(Vec::new()).unwrap();
        let res = handle(&req);
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(res.headers()[header::CONTENT_SECURITY_POLICY], ERROR_POLICY);
        assert!(!String::from_utf8(res.body().to_vec()).unwrap().contains("<"));
    }

    #[test]
    fn viewer_policy_allows_no_script_and_no_plain_http() {
        let p = VIEWER_POLICY;
        assert!(p.starts_with("default-src 'none';"));
        assert!(!p.contains("script-src"));
        assert!(!p.contains("http:"));
        assert!(!p.contains("data:"));
        assert!(!p.contains("frame-src"));
    }
}
