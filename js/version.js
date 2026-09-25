/**
 * Compare two dotted version strings for the update check: true when
 * `candidate` is newer than `running`. A leading "v" is ignored, a missing or
 * non-numeric part counts as 0 (so "2.1" equals "2.1.0"), and unparseable
 * input never reads as newer, so garbage from the network cannot raise the
 * update prompt.
 */
function isNewerVersion(candidate, running){
    var a = String(candidate).trim().replace(/^v/i, '').split('.'),
        b = String(running).trim().replace(/^v/i, '').split('.'),
        n = Math.max(a.length, b.length);
    for(var i = 0; i < n; i++){
        var x = parseInt(a[i], 10) || 0,
            y = parseInt(b[i], 10) || 0;
        if(x !== y)
            return x > y;
    }
    return false;
}
