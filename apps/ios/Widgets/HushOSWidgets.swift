import ActivityKit
import HushOSKit
import SwiftUI
import WidgetKit

@main
struct HushOSWidgetsBundle: WidgetBundle {
    var body: some Widget {
        TransferLiveActivity()
    }
}

/* Uploads and downloads on the Lock Screen and in the Dynamic Island: the file, a bar, the percentage. */
struct TransferLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TransferAttributes.self) { context in
            HStack(spacing: 12) {
                Image(systemName: icon(context))
                    .font(.title2).foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 6) {
                    Text(context.state.title).font(.subheadline.weight(.medium)).lineLimit(1)
                    ProgressView(value: context.state.fraction).tint(Color.accentColor)
                }
                Text(percent(context)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
            }
            .padding(16)
            .activityBackgroundTint(Color(red: 0.902, green: 0.886, blue: 0.851))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: icon(context)).font(.title2).foregroundStyle(Color.accentColor).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(percent(context)).font(.headline.monospacedDigit()).padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(context.state.title).font(.subheadline).lineLimit(1)
                        ProgressView(value: context.state.fraction).tint(Color.accentColor)
                    }
                }
            } compactLeading: {
                Image(systemName: icon(context)).foregroundStyle(Color.accentColor)
            } compactTrailing: {
                Text(percent(context)).font(.caption2.monospacedDigit())
            } minimal: {
                ProgressView(value: context.state.fraction).progressViewStyle(.circular).tint(Color.accentColor)
            }
        }
    }

    private func icon(_ context: ActivityViewContext<TransferAttributes>) -> String {
        if context.state.done { return "checkmark.circle.fill" }
        return context.attributes.kind == "upload" ? "arrow.up.circle.fill" : "arrow.down.circle.fill"
    }

    private func percent(_ context: ActivityViewContext<TransferAttributes>) -> String {
        context.state.done ? "Done" : "\(Int(context.state.fraction * 100))%"
    }
}
