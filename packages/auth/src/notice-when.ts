const noticeTime = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
});

/* When something happened, as every notice to an account's email says it. */
export const noticeWhen = (at: Date = new Date()) => `${noticeTime.format(at)} UTC`;
