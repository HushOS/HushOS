/*
 * The segmented control, wherever it is drawn (Settings, the operator filters, Shared, the preview's
 * Formatted and Source, the tree view's Tree and Text, Pricing's planner): one track and one chosen
 * segment, so every copy stays the same.
 *
 * The track is a groove in the ground, below the panel in both schemes, so the chosen segment, the
 * panel's surface, reads as raised. The segment's edge is a hairline drawn inside it, never a drop
 * shadow: in a track 2px or 4px deep a shadow fills the inset under the segment (in the dark nearly
 * all of it), and the segment looks as if it sinks. High contrast makes the hairline solid.
 */
export const segmentTrack = 'bg-ground';
export const segmentOn = 'bg-card text-foreground inset-ring inset-ring-edge';
