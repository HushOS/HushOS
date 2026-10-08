import { createIsomorphicFn } from '@tanstack/react-start';
import { useRequest } from 'nitro/context';

/*
 * Safari on iPhone and iPad zooms the page in when a field under 16px is focused, and the
 * zoom stays when the app moves to another page. `maximum-scale=1` stops that zoom, and on
 * iOS and iPadOS it does nothing else: Safari has ignored it for pinch-zoom since iOS 10.
 * On Android it would block pinch-zoom, so it goes only to Apple devices. iPads in desktop
 * mode say Macintosh, and desktop browsers ignore the viewport tag, so Macintosh is included.
 */
const APPLE = /iPhone|iPad|iPod|Macintosh/;

export const isAppleTouch = createIsomorphicFn()
    .server(() => APPLE.test(useRequest().headers.get('user-agent') ?? ''))
    .client(() => APPLE.test(navigator.userAgent));

export function viewportContent(apple: boolean) {
    return `width=device-width, initial-scale=1, viewport-fit=cover${apple ? ', maximum-scale=1' : ''}`;
}
