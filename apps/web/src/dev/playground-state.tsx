import { useDialKit } from 'dialkit';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';

/*
 * What the playground's own settings say, for every demo: the colour scheme, the measuring
 * overlay and the forced states. They live in DialKit's first panel, Playground, which
 * DialKit keeps in this browser (`persist`), so a reload while tuning keeps the view.
 */

export const SCHEMES = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'light-hc', label: 'Light HC' },
    { value: 'dark-hc', label: 'Dark HC' },
] as const;
export type Scheme = (typeof SCHEMES)[number]['value'];

type View = { scheme: Scheme; measure: boolean; states: boolean };
const initial: View = { scheme: 'light', measure: false, states: true };

const PlaygroundContext = createContext<View>(initial);

export function PlaygroundState({ children }: { children: ReactNode }) {
    const [view, setView] = useState(initial);
    useScheme(view.scheme);
    return (
        <PlaygroundContext value={view}>
            {/*
             * First in the tree, so its panel registers before any demo's (DialKit adds panels
             * in effect order, and an earlier sibling's effects run first): Playground on top.
             */}
            <PlaygroundPanel onChange={setView} />
            {children}
        </PlaygroundContext>
    );
}

function PlaygroundPanel({ onChange }: { onChange: (view: View) => void }) {
    const dial = useDialKit(
        'Playground',
        {
            scheme: { type: 'select', options: [...SCHEMES], default: initial.scheme },
            measure: initial.measure,
            states: initial.states,
        },
        { id: 'playground', persist: true },
    );
    const scheme = SCHEMES.find((item) => item.value === dial.scheme)?.value ?? initial.scheme;
    useEffect(
        () => onChange({ scheme, measure: dial.measure, states: dial.states }),
        [onChange, scheme, dial.measure, dial.states],
    );
    return null;
}

export function usePlayground() {
    return use(PlaygroundContext);
}

/*
 * The app puts its scheme on <html> as `light` or `dark`, plus `hc` for high contrast
 * (__root.tsx, styles.css). The playground sets the same classes, so portals (menus,
 * dialogs, toasts) follow too, without saving the choice to the appearance cookie, and
 * puts the page's own back when it closes.
 */
function useScheme(scheme: Scheme) {
    useEffect(() => {
        const html = document.documentElement;
        const before = html.className;
        html.classList.remove('light', 'dark', 'hc');
        html.classList.add(scheme.startsWith('dark') ? 'dark' : 'light');
        if (scheme.endsWith('-hc')) html.classList.add('hc');
        return () => {
            html.className = before;
        };
    }, [scheme]);
}
