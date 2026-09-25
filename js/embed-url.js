/**
 * Classify a media URL taken from asset metadata before it reaches a src
 * attribute. Returns one of:
 *
 *   'youtube'    https://www.youtube.com/embed/...      fit for an <iframe>
 *   'soundcloud' https://api.soundcloud.com/tracks/...  fit for an <iframe>
 *   'url'        any other http(s) URL                  fit for <video>/<audio>
 *   false        anything else: javascript:, data:, file:, unparseable input
 *
 * Only the two iframe kinds are tied to a host and path prefix; everything
 * else that parses as http(s) is left to the media element, which cannot run
 * script from its src. Parsing goes through the URL constructor so scheme and
 * host are read the way the browser reads them: leading whitespace, tabs
 * inside the scheme, mixed case and userinfo (https://host@evil.com/) are all
 * normalised before the checks run.
 */
function classifyMediaUrl(url){
    var parsed;
    try {
        parsed = new URL(String(url));
    } catch (_) {
        return false;
    }
    var https = parsed.protocol === 'https:';
    if(!https && parsed.protocol !== 'http:')
        return false;
    var host = parsed.hostname.toLowerCase(),
        path = parsed.pathname;
    if(https && (host === 'www.youtube.com' || host === 'youtube.com') && path.indexOf('/embed/') === 0)
        return 'youtube';
    if(https && host === 'api.soundcloud.com' && path.indexOf('/tracks/') === 0)
        return 'soundcloud';
    return 'url';
}
