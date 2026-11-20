import HushOSKit
import SwiftUI

/*
 * A folder's colour, as the web's dialog offers it: the plain folder colour every folder
 * starts with, the eight swatches, or a colour of its own from the system picker. Choosing
 * only marks the choice; Save writes one signed record per folder (nil for the plain colour).
 */
struct FolderColourSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let folders: [Opened]
    @State private var choice: String?
    @State private var custom = Color(red: 0.486, green: 0.361, blue: 0.749)
    @State private var loaded = false
    private let swatches = folderSwatches()

    private var what: String { folders.count == 1 ? "“\(folders[0].name)”" : "\(folders.count) folders" }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: Alpine.Space.s1)], spacing: Alpine.Space.s1) {
                        swatch(nil, "Default", fill: Alpine.folderFront, check: Alpine.folderBack)
                        ForEach(swatches, id: \.colour) { swatch in
                            self.swatch(swatch.colour, swatch.name, fill: Color(argb: swatchArgb(colour: swatch.colour)), check: .white)
                        }
                    }
                    .alpineRow()
                    ColorPicker("Custom colour", selection: Binding(get: { custom }, set: { custom = $0; choice = TagColour.hex($0) }), supportsOpacity: false)
                        .alpineRow()
                } footer: {
                    Text(folders.count == 1 ? "People who can open this folder see the colour too." : "People who can open these folders see the colour too.")
                }
            }
            .alpineGrouped()
            .navigationTitle("Colour")
            .navigationSubtitle(Text(what))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let picked = folders
                        let colour = choice
                        dismiss()
                        Task { await store.recolour(picked, to: colour) }
                    }
                }
            }
            .onAppear {
                guard !loaded, let first = folders.first else { return }
                loaded = true
                choice = folderColour(attributes: first.metadata.attributes)
                if let own = choice, !swatches.contains(where: { $0.colour == own }) { custom = TagColour.swiftUI(own) }
            }
        }
        .presentationDetents([.medium])
    }

    private func swatch(_ value: String?, _ name: String, fill: Color, check: Color) -> some View {
        let on = value == choice
        return Button { choice = value } label: {
            Circle().fill(fill).frame(width: 32, height: 32)
                .overlay { if on { Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(check) } }
                .padding(4)
                .overlay { Circle().strokeBorder(on ? Alpine.ink : .clear, lineWidth: 2) }
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name)
        .accessibilityAddTraits(on ? [.isSelected] : [])
    }
}

private extension Color {
    /* An ARGB value from the core (`0xFFrrggbb`), opaque sRGB. */
    init(argb: UInt32) {
        self.init(red: Double((argb >> 16) & 0xff) / 255, green: Double((argb >> 8) & 0xff) / 255, blue: Double(argb & 0xff) / 255)
    }
}
