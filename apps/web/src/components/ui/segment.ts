/*
 * The segmented control, wherever it is drawn (Settings, the operator filters, Shared, the preview's
 * Formatted and Source, the tree view's Tree and Text, Pricing's planner): one track and one chosen
 * segment, so every copy stays the same.
 *
 * The track is a soft groove, the ink at 7% over whatever it sits on, so it shows on a panel and on
 * the public pages' ground alike. The chosen segment is raised out of it: the card with the
 * smallest shadow and a hairline in light, a lighter fill in the dark, where a shadow can't be
 * seen. Owner's pick of three (2026-10-27): a border round the track read as a form field, and
 * the selection tint was too close to the track in light. High contrast drops the shadow and makes
 * the hairline solid.
 */
export const segmentTrack = 'bg-foreground/7';
export const segmentOn =
    'bg-card text-foreground shadow-sheet inset-ring inset-ring-edge dark:bg-foreground/16 dark:shadow-none';
