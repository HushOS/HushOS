import HushOSKit
import SwiftUI

/*
 * The Unverified mark (docs/integrity-design.md, "Reading"): an item whose writer this
 * person can't tie to someone they checked. A caution, not a lock: the item still opens.
 * Small and in the warning colour (danger for a signature that doesn't hold), with the
 * reason a tap away, and the way out where there is one.
 */
extension Provenance {
    var colour: Color {
        if case .badSignature = self { return Alpine.danger }
        return Alpine.warning
    }

    /* Someone to check: the writer the server names, when it is not a signature that failed. */
    var checkable: Signer? {
        if case .unknownSigner(let signer?) = self, !signer.email.isEmpty { return signer }
        return nil
    }
}

/* The mark as words on a row's line, for places that can't take a tap of their own (grid tiles). */
enum UnverifiedText {
    static func text(_ provenance: Provenance) -> Text {
        Text("\(LineIcon.text("exclamationmark.shield", colour: provenance.colour, label: "")) \(Text("Unverified").foregroundStyle(provenance.colour).fontWeight(.semibold))")
    }
}

/*
 * The mark as a button: "Unverified" with a small shield, which explains itself in a
 * popover and, for someone not checked yet, offers to check their words.
 */
struct UnverifiedMark: View {
    @Environment(DriveStore.self) private var store
    let provenance: Provenance
    /* A whole row's worth (Info), rather than the compact mark on a line. */
    var row = false
    @State private var explaining = false
    @State private var checking: Signer?

    var body: some View {
        Button { explaining = true } label: { label }
            .buttonStyle(.borderless)
            .accessibilityLabel("Unverified")
            .accessibilityHint(provenance.explanation)
            .popover(isPresented: $explaining) {
                UnverifiedExplanation(provenance: provenance) { signer in
                    explaining = false
                    checking = signer
                }
                .presentationCompactAdaptation(.popover)
            }
            .sheet(item: $checking) { signer in
                NavigationStack {
                    CheckContactView(email: signer.email, intro: "Check it’s them before you trust what they add or change.") { pin in
                        checking = nil
                        store.notify("\(pin.name.isEmpty ? pin.email : pin.name) checked")
                        Task { await store.refreshSigners() }
                    }
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { checking = nil } } }
                }
                .environment(store)
            }
    }

    @ViewBuilder private var label: some View {
        if row {
            HStack {
                Label("Unverified", systemImage: "exclamationmark.shield").foregroundStyle(provenance.colour).fontWeight(.semibold)
                Spacer()
                Image(systemName: "info.circle").foregroundStyle(Alpine.inkMuted)
            }
            .contentShape(Rectangle())
        } else {
            HStack(spacing: 3) {
                Image(systemName: "exclamationmark.shield")
                Text("Unverified")
            }
            .font(Theme.Text.footnote.weight(.semibold))
            .foregroundStyle(provenance.colour)
            .lineLimit(1)
            .fixedSize()
            .frame(minHeight: 30)
            .contentShape(Rectangle())
        }
    }
}

/* Why an item is unverified, in the words every client uses, and the way out when there is one. */
struct UnverifiedExplanation: View {
    let provenance: Provenance
    let check: (Signer) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Alpine.Space.s3) {
            Label("Unverified", systemImage: "exclamationmark.shield").font(Theme.Text.headline).foregroundStyle(provenance.colour)
            Text(provenance.explanation).font(Theme.Text.callout).foregroundStyle(Alpine.ink).fixedSize(horizontal: false, vertical: true)
            if let signer = provenance.checkable {
                Button { check(signer) } label: { Text("Check their words").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle())
            }
        }
        .padding(Alpine.Space.s4)
        .frame(idealWidth: 320, maxWidth: 360)
    }
}
