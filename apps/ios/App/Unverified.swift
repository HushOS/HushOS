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
        if case .family(let mark) = self, mark.danger { return Alpine.danger }
        return Alpine.warning
    }

    /* A check that could not run offers Try again. */
    var retryable: Bool {
        if self == .unchecked { return true }
        if case .family(let mark) = self { return mark.retry }
        return false
    }

    /* The mark's word: drawn alike, but a check that couldn't run says so rather than passing for a verdict. */
    var title: String {
        if self == .unchecked { return "Couldn’t check" }
        if case .family(let mark) = self { return mark.label }
        // A key conflict is worse than Unverified and says so, as the web's mark does.
        if case .keyConflict = self { return "Keys don’t match" }
        return "Unverified"
    }
}

/*
 * Someone to check, where a pin action makes sense: an unknown signer this person has pinned
 * without a words check that counts, or who shared the item with them. The server names the
 * signer by id only, so a stranger it names offers nothing: there is no one to look up.
 */
struct CheckTarget: Identifiable, Hashable {
    let id: String
    let email: String
}

extension DriveStore {
    func checkTarget(for provenance: Provenance) -> CheckTarget? {
        let signer: String?
        switch provenance {
        case .unknownSigner(let id): signer = id
        case .family(let mark): signer = mark.check
        default: signer = nil
        }
        guard let signerId = signer else { return nil }
        let id = signerId.lowercased()
        if let mount = mounts.first(where: { $0.share.granter.id.lowercased() == id }), !mount.share.granter.email.isEmpty {
            return CheckTarget(id: id, email: mount.share.granter.email)
        }
        if let pin = pins[id], !pin.email.isEmpty { return CheckTarget(id: id, email: pin.email) }
        return nil
    }
}

/* The mark as words on a row's line, for places that can't take a tap of their own (grid tiles). */
enum UnverifiedText {
    static func text(_ provenance: Provenance) -> Text {
        Text("\(LineIcon.text("exclamationmark.shield", colour: provenance.colour, label: "")) \(Text(provenance.title).foregroundStyle(provenance.colour).fontWeight(.semibold))")
    }
}

/*
 * The mark as a button: "Unverified" with a small shield, which explains itself in a
 * popover and, where there is one, offers the way out: checking someone's words, or
 * trying again when the check couldn't run.
 */
struct UnverifiedMark: View {
    @Environment(DriveStore.self) private var store
    let provenance: Provenance
    /* A whole row's worth (Info), rather than the compact mark on a line. */
    var row = false
    @State private var explaining = false
    @State private var checking: CheckTarget?

    var body: some View {
        Button { explaining = true } label: { label }
            .buttonStyle(.borderless)
            .accessibilityLabel(provenance.title)
            .accessibilityHint(provenance.explanation)
            .popover(isPresented: $explaining) {
                UnverifiedExplanation(provenance: provenance, target: store.checkTarget(for: provenance)) { target in
                    explaining = false
                    checking = target
                } retry: {
                    explaining = false
                    Task { await store.refreshSigners() }
                }
                .presentationCompactAdaptation(.popover)
            }
            .sheet(item: $checking) { target in
                NavigationStack {
                    CheckContactView(email: target.email, intro: "Check it’s them before you trust what they add or change.") { pin in
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
                Label(provenance.title, systemImage: "exclamationmark.shield").foregroundStyle(provenance.colour).fontWeight(.semibold)
                Spacer()
                Image(systemName: "info.circle").foregroundStyle(Alpine.inkMuted)
            }
            .contentShape(Rectangle())
        } else {
            HStack(spacing: 3) {
                Image(systemName: "exclamationmark.shield")
                Text(provenance.title)
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
    let target: CheckTarget?
    let check: (CheckTarget) -> Void
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Alpine.Space.s3) {
            Label(provenance.title, systemImage: "exclamationmark.shield").font(Theme.Text.headline).foregroundStyle(provenance.colour)
            Text(provenance.explanation).font(Theme.Text.callout).foregroundStyle(Alpine.ink).fixedSize(horizontal: false, vertical: true)
            if provenance.retryable {
                Button { retry() } label: { Text("Try again").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle())
            } else if let target {
                Button { check(target) } label: { Text("Check their words").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle())
            }
        }
        .padding(Alpine.Space.s4)
        .frame(idealWidth: 320, maxWidth: 360)
    }
}
