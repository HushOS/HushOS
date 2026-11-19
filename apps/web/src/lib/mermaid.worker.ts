import { drawDiagram } from '@/lib/mermaid-render';

/*
 * The diagram worker (lib/mermaid.ts): pele off the main thread, one diagram per message. Fetched
 * whole with the viewers' post-unlock preload ("preload" answers "ready"), so drawing fetches nothing.
 */
self.onmessage = (event: MessageEvent<{ kind: 'preload' } | { id: number; source: string }>) => {
    const message = event.data;
    if ('kind' in message) {
        self.postMessage({ kind: 'ready' });
        return;
    }
    self.postMessage({ id: message.id, outcome: drawDiagram(message.source) });
};
