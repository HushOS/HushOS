/*
 * Which key presses scroll the page, for the long list's guard against moving the scroll
 * under a person who is scrolling (virtual-list.tsx). A scrolling key counts unless the
 * focused element takes it for itself: a text field takes them all, a select its arrows and
 * Space, a button or a checkbox its Space. A link takes Enter, not Space, so Space on a link
 * still pages the list.
 */

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const ARROWS = new Set(['ArrowUp', 'ArrowDown']);

/* Input types that edit text or a value with every key: the caret or the value moves. */
const TEXT_INPUTS = new Set([
    'text',
    'search',
    'email',
    'url',
    'tel',
    'password',
    'number',
    'date',
    'datetime-local',
    'month',
    'time',
    'week',
    'range',
]);
/* Input types that Space presses. A radio's arrows move the choice through its group. */
const SPACE_INPUTS = new Set(['checkbox', 'button', 'submit', 'reset', 'file', 'color', 'image']);

/* Roles whose widget takes every scrolling key (ARIA's keyboard patterns). */
const TAKES_ALL = '[role=textbox], [role=slider], [role=spinbutton]';
/* Roles whose widget takes the arrows and Space. */
const TAKES_ARROWS = '[role=combobox], [role=listbox]';
/* Roles whose widget Space presses. */
const TAKES_SPACE =
    '[role=button], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=tab]';

type Takes = 'all' | 'arrows' | 'space' | 'none';

function takes(target: Element): Takes {
    if (target instanceof HTMLInputElement) {
        // `type` reads 'text' for a missing or unknown type, as the browser treats it.
        if (TEXT_INPUTS.has(target.type)) return 'all';
        if (target.type === 'radio') return 'arrows';
        if (SPACE_INPUTS.has(target.type)) return 'space';
        return 'none';
    }
    if (target instanceof HTMLTextAreaElement) return 'all';
    if (target.closest('[contenteditable]:not([contenteditable="false"])')) return 'all';
    if (target instanceof HTMLSelectElement) return 'arrows';
    if (target.matches(TAKES_ALL)) return 'all';
    if (target.matches(TAKES_ARROWS)) return 'arrows';
    if (target instanceof HTMLButtonElement || target.localName === 'summary') return 'space';
    if (target.matches(TAKES_SPACE)) return 'space';
    return 'none';
}

/**
 * Whether `key`, pressed with `target` focused, scrolls the page rather than being taken by
 * the focused element. `target` is the keydown's target: the focused element, or the body.
 */
export function scrollsByKey(key: string, target: EventTarget | null) {
    if (!SCROLL_KEYS.has(key)) return false;
    if (!(target instanceof Element)) return true;
    switch (takes(target)) {
        case 'all':
            return false;
        case 'arrows':
            return !ARROWS.has(key) && key !== ' ';
        case 'space':
            return key !== ' ';
        case 'none':
            return true;
    }
}
