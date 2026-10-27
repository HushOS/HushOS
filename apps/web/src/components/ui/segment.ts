/*
 * The segmented control, wherever it is drawn (Settings, the operator filters, Shared, the preview's
 * Formatted and Source, the tree view's Tree and Text, Pricing's planner): one track and one chosen
 * segment, so every copy stays the same.
 *
 * The track is a groove in the ground. The chosen segment is the selection: tint with on-tint words
 * and a hairline drawn inside it, so it reads as chosen on any ground. A raised surface didn't: on
 * the public pages the page is the ground, the track vanishes, and in the dark the surface is a
 * shade off it. Never a drop shadow: in a track 2px or 4px deep a shadow fills the inset under the
 * segment, and it looks as if it sinks. High contrast makes the hairline solid.
 */
export const segmentTrack = 'bg-ground';
export const segmentOn = 'bg-accent text-accent-foreground inset-ring inset-ring-edge';
