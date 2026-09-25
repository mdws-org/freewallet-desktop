import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// js/embed-url.js is a classic browser script (a top-level function, no
// exports). Run it in a bare context that has only URL and read the function
// back out, which mirrors how index.html's <script> tag exposes it as a global.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'js', 'embed-url.js'), 'utf8');
const context = { URL };
vm.runInNewContext(source, context);
const { classifyMediaUrl } = context;

function check(cases, expected){
    for (const input of cases)
        assert.equal(classifyMediaUrl(input), expected, JSON.stringify(input));
}

test('script defines classifyMediaUrl as a global', () => {
    assert.equal(typeof classifyMediaUrl, 'function');
});

test('rejects script-bearing and non-http schemes', () => {
    check([
        'javascript:alert(document.domain)//youtube.mp4',
        'javascript:alert(1)//x.http.youtube.mp4',
        'JavaScript:alert(1)//youtube',
        ' javascript:alert(1)//youtube',
        'java\tscript:alert(1)//youtube',
        'java\nscript:alert(1)//soundcloud',
        'data:text/html,<script>alert(1)</script>//youtube',
        'vbscript:msgbox(1)//soundcloud',
        'file:///etc/passwd.mp4',
        'ftp://example.com/video.mp4',
        'blob:https://www.youtube.com/embed/x',
    ], false);
});

test('rejects input that is not an absolute URL', () => {
    check([
        '',
        'not a url',
        'example.com/video.mp4',
        '//www.youtube.com/embed/x',
        '/embed/x',
        null,
        undefined,
        false,
        0,
        {},
    ], false);
});

test('accepts the youtube embed origin only', () => {
    check([
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
        'https://youtube.com/embed/dQw4w9WgXcQ',
        'https://www.youtube.com/embed/dQw4w9WgXcQ?start=30',
        'HTTPS://WWW.YOUTUBE.COM/embed/dQw4w9WgXcQ',
    ], 'youtube');
});

test('accepts the soundcloud tracks origin only', () => {
    check([
        'https://api.soundcloud.com/tracks/123456789',
        'https://api.soundcloud.com/tracks/123456789?secret_token=abc',
    ], 'soundcloud');
});

test('lookalike iframe URLs are plain urls, never iframe kinds', () => {
    check([
        'https://evil.com/youtube',
        'https://evil.com/youtube.mp4',
        'https://www.youtube.com.evil.com/embed/x',
        'https://www.youtube.com@evil.com/embed/x',
        'https://www.youtube.com\\@evil.com/embed/x',
        'https://evil.com/?u=https://www.youtube.com/embed/x',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/evil/embed/x',
        'http://www.youtube.com/embed/dQw4w9WgXcQ',
        'https://soundcloud.com/tracks/1',
        'https://api.soundcloud.com/users/1',
        'https://api.soundcloud.com.evil.com/tracks/1',
        'http://api.soundcloud.com/tracks/1',
    ], 'url');
});

test('ordinary http(s) media URLs are plain urls', () => {
    check([
        'https://example.com/video.mp4',
        'http://example.com/song.mp3',
        'https://i.imgur.com/abc123.gif',
        'https://example.com/clip.mov?token=1#t=5',
    ], 'url');
});
