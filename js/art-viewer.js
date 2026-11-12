/**
 * Asset artwork from remote hosts, shown in a sandboxed frame.
 *
 * Artwork URLs come from asset metadata and can name any host. Under the
 * Tauri shell the wallet page may only load images from a short list of
 * origins, so an https image is framed through the shell's artwork viewer
 * instead (src-tauri/src/art_viewer.rs): a script-free page served at
 * fwart://localhost/view whose own policy allows https images and nothing
 * else. The frame carries an empty sandbox attribute, so it runs no script,
 * opens no popups and has an opaque origin.
 *
 * Under NW.js (no Tauri host) and for data: URIs, artFrameSrc returns false
 * and the caller shows the image in the page as before.
 */

// The viewer URL for an artwork URL, or false if it is not an https image URL.
// ipfs:// URLs are read through the ipfs.io gateway, the same gateway the
// wallet uses for ipfs: asset descriptions.
function artViewerUrl(url){
    var s = String(url == null ? '' : url).trim(),
        ipfs = /^ipfs:\/\/(?:ipfs\/)?/i;
    if(ipfs.test(s))
        s = 'https://ipfs.io/ipfs/' + s.replace(ipfs, '');
    var parsed;
    try {
        parsed = new URL(s);
    } catch (_) {
        return false;
    }
    if(parsed.protocol !== 'https:' || !parsed.hostname)
        return false;
    return 'fwart://localhost/view?src=' + encodeURIComponent(parsed.href);
}

// artViewerUrl, but only when the page runs under the Tauri shell.
function artFrameSrc(url){
    if(typeof window === 'undefined' || !window.__TAURI_INTERNALS__)
        return false;
    return artViewerUrl(url);
}

// Put the artwork frame in #artwork-frame and hide the loader once it loads.
function showArtFrame(src, loader){
    var frame = $('<iframe class="artwork-frame" sandbox="" referrerpolicy="no-referrer" title="Asset artwork"></iframe>');
    frame.one('load', function(){ loader.hide(); });
    frame.attr('src', src);
    $('#artwork-frame').empty().append(frame).show();
}

// Hand cb the text of an artwork URL. A base64 data: URI is decoded here (a
// request for it would be refused by connect-src); anything else is fetched.
function withArtData(url, cb){
    var m = /^data:[^,]*;base64,(.*)$/i.exec(String(url));
    if(!m){
        $.get(url, cb);
        return;
    }
    var text = '';
    try { text = atob(m[1]); } catch (_) {}
    cb(text);
}
