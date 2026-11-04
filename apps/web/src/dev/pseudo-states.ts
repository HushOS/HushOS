/*
 * Hover and focus-visible can't be set from script, so the playground copies what the
 * stylesheets say for them onto attributes: every `:hover` also matches inside an element
 * marked `data-force~="hover"`, and every `:focus-visible` inside `data-force~="focus"`.
 * Storybook's pseudo-states addon does the same. Only the playground marks anything, so
 * the rest of the app is unchanged; Vite's replaced stylesheets are rewritten again.
 */

const RULES: [RegExp, string][] = [
    [/:hover(?![\w-])/g, ':is(:hover, [data-force~="hover"] *, [data-force~="hover"])'],
    [
        /:focus-visible(?![\w-])/g,
        ':is(:focus-visible, [data-force~="focus"] *, [data-force~="focus"])',
    ],
];
const done = new WeakSet<CSSStyleSheet>();

function rewrite(rules: CSSRuleList) {
    for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule && !rule.selectorText.includes('data-force')) {
            let selector = rule.selectorText;
            for (const [pattern, replacement] of RULES)
                selector = selector.replace(pattern, replacement);
            if (selector !== rule.selectorText) rule.selectorText = selector;
        }
        // Media queries, layers, supports and Tailwind's nested rules.
        if ('cssRules' in rule) rewrite((rule as CSSGroupingRule).cssRules);
    }
}

function rewriteAll() {
    for (const sheet of Array.from(document.styleSheets)) {
        if (done.has(sheet)) continue;
        try {
            rewrite(sheet.cssRules);
            done.add(sheet);
        } catch {
            // A cross-origin sheet can't be read; none of ours is.
        }
    }
}

export function forcePseudoStates() {
    rewriteAll();
    let frame = 0;
    const observer = new MutationObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(rewriteAll);
    });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
    };
}
