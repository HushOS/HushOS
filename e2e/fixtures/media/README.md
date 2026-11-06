# Media fixtures

`clip.webm`: one second of ffmpeg's test pattern and a 440 Hz tone (VP8 and Opus, 160x120), made for `e2e/media-preview.spec.ts` with:

```sh
ffmpeg -f lavfi -i testsrc=size=160x120:rate=10 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 1 -c:v libvpx -b:v 60k -c:a libopus -b:a 32k clip.webm
```

WebM, not MP4: Playwright's Chromium has no H.264.
