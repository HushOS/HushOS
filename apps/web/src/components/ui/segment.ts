/*
 * The segmented control, wherever it is drawn (Settings, the operator filters, Shared, the preview's
 * Formatted and Source, the tree view's Tree and Text, Pricing's planner): one track and one chosen
 * segment, so every copy stays the same.
 *
 * The track is a groove in the ground with a field's border, so the control reads as one thing to
 * press, like the inputs and selects beside it. The chosen segment is the selection: tint with
 * on-tint words and a hairline drawn inside it. A raised surface in a borderless groove didn't
 * read: on the public pages the page is the ground, so the track vanished, the other options
 * looked like plain words, and in the dark the chosen surface was a shade off the page. Never a
 * drop shadow: in a track 2px or 4px deep a shadow fills the inset under the segment, and it
 * looks as if it sinks. High contrast makes both lines solid.
 */
export const segmentTrack = 'bg-ground inset-ring inset-ring-input';
export const segmentOn = 'bg-accent text-accent-foreground inset-ring inset-ring-edge';
