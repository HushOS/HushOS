import { useEffect, useState } from 'react';

/* `value` once it has stopped changing for `delay` ms: what a search as you type asks for. */
export function useDebouncedValue<T>(value: T, delay = 300) {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setSettled(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);
    return settled;
}
