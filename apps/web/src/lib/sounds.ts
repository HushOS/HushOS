import { bind, play, setEnabled, setVolume, type SoundName } from 'cuelume';
import { useSyncExternalStore } from 'react';

/*
 * Cuelume gives interactions a quiet, consistent acoustic signature.
 * HushOS owns the preference; Cuelume only applies it. Declarative cues live
 * on markup (`data-cuelume-*`), and the few semantic cues (success, error,
 * ready) are played from code via `cue()` so every flow sounds the same.
 */

const STORAGE_KEY = 'hushos-sounds';
const DEFAULT_VOLUME = 0.55;
const listeners = new Set<() => void>();
let enabled = true;
let ready = false;

function readPreference() {
    try {
        return window.localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch {
        return true;
    }
}

function emit() {
    for (const listener of listeners) listener();
}

export function initSounds(root?: ParentNode) {
    if (typeof window === 'undefined' || ready) return;
    ready = true;
    enabled = readPreference();
    setEnabled(enabled);
    setVolume(DEFAULT_VOLUME);
    bind(root);
    // Links are buttons too. Any anchor without its own press cue gets the shared one.
    const target = (event: Event) =>
        event.target instanceof Element
            ? event.target.closest('a[href]:not([data-cuelume-press])')
            : null;
    document.addEventListener('pointerdown', (event) => target(event) && play('press'), true);
    document.addEventListener('pointerup', (event) => target(event) && play('release'), true);
}

export function setSoundsEnabled(value: boolean) {
    enabled = value;
    setEnabled(value);
    try {
        window.localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
    } catch {
        /* Preference simply won't persist. */
    }
    emit();
    if (value) play('toggle', { volume: 0.5 });
}

export function cue(name: SoundName, options?: { volume?: number }) {
    if (typeof window === 'undefined') return;
    play(name, options);
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useSoundsEnabled() {
    return useSyncExternalStore(
        subscribe,
        () => enabled,
        () => true,
    );
}
