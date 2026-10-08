import HushOSKit
import SwiftUI

/*
 * The sheet: what is being saved, where it goes (the folder last added to, or Files, with
 * Change), and Save. Signed out, it says so and offers nothing else: an extension can't
 * open the app. Android's words throughout.
 */
struct SaveView: View {
    @Bindable var model: SaveModel
    let close: () -> Void
    @State private var path: [Places.Folder] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                switch model.phase {
                case .signedOut:
                    Text("Sign in to HushOS in the app first.")
                        .font(.body).foregroundStyle(Alpine.inkMuted)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .padding(Alpine.Space.s6)
                        .background(Alpine.ground)
                case .opening:
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background(Alpine.ground)
                default:
                    items
                }
            }
            .navigationTitle("Save to HushOS")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: close).disabled(model.phase == .saving) }
            }
            .navigationDestination(for: Places.Folder.self) { folder in
                FolderPicker(model: model, here: folder, path: $path)
            }
        }
        .tint(Alpine.primary)
    }

    private var saving: Bool { model.phase == .saving }

    private var items: some View {
        List {
            Section {
                ForEach(model.items.prefix(6)) { item in
                    HStack(spacing: Alpine.Space.s3) {
                        PageGlyph(label: Self.label(item.name)).frame(width: Theme.mark * 0.66, height: Theme.mark * 0.66 * 54 / 44)
                            .frame(width: Theme.mark, height: Theme.mark)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.name).font(Theme.Text.body).foregroundStyle(Alpine.ink).lineLimit(1).truncationMode(.middle)
                            if item.unreadable {
                                Text("Couldn’t be read, so it won’t be saved.").font(Theme.Text.footnote).foregroundStyle(Alpine.danger)
                            } else if let note = model.note {
                                Text(note).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                            } else if let size = item.size {
                                Text(formatBytes(size)).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                            } else {
                                ProgressView().controlSize(.mini)
                            }
                        }
                    }
                    .frame(minHeight: Theme.row)
                    .alpineRow()
                }
                if model.items.count > 6 {
                    Text("and \(model.items.count - 6) more").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).alpineRow()
                }
            }
            Section {
                // Where it goes: the folder last added to, or Files; Change opens the picker.
                Button {
                    if let root = model.root { path = [root] }
                } label: {
                    HStack(spacing: Alpine.Space.s3) {
                        FolderGlyph().frame(width: Theme.mark * 0.9, height: Theme.mark * 0.9 * 46 / 56).frame(width: Theme.mark, height: Theme.mark)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Save in").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                            Text(model.folder?.name ?? "Finding your files").font(Theme.Text.body).foregroundStyle(Alpine.ink).lineLimit(1)
                        }
                        Spacer()
                        if model.root != nil { Text("Change").font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary) }
                    }
                    .frame(minHeight: Theme.row)
                }
                .buttonStyle(.plain)
                .disabled(saving || model.root == nil)
                .alpineRow()
            } footer: {
                if let problem = model.problem { Text(problem).foregroundStyle(Alpine.danger) }
            }
            Section {
                Button { Task { await model.save() } } label: { Text(saving ? "Saving…" : "Save").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle())
                    .disabled(saving || model.folder == nil || !model.items.contains { $0.copy != nil })
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            }
        }
        .alpineGrouped()
    }

    static func label(_ name: String) -> String? {
        let ext = (name as NSString).pathExtension.uppercased()
        return (1 ... 4).contains(ext.count) ? ext : nil
    }
}

/* The folders of your drive, walked from Files; Save here picks the one you're in. */
private struct FolderPicker: View {
    let model: SaveModel
    let here: Places.Folder
    @Binding var path: [Places.Folder]
    @State private var folders: Result<[Opened], Error>?

    var body: some View {
        List {
            switch folders {
            case nil:
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            case let .failure(error):
                Text((error as? LocalizedError)?.errorDescription ?? "Couldn’t reach HushOS. Check your connection, then try again.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).frame(maxWidth: .infinity).multilineTextAlignment(.center)
                    .listRowBackground(Color.clear)
            case let .success(list) where list.isEmpty:
                Text("No folders in here.").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).frame(maxWidth: .infinity)
                    .padding(.vertical, 40).listRowBackground(Color.clear)
            case let .success(list):
                Section {
                    ForEach(list, id: \.id) { folder in
                        NavigationLink(value: Places.Folder(id: folder.id, name: folder.name)) {
                            HStack(spacing: Alpine.Space.s3) {
                                FolderGlyph().frame(width: Theme.mark * 0.9, height: Theme.mark * 0.9 * 46 / 56).frame(width: Theme.mark, height: Theme.mark)
                                Text(folder.name).font(Theme.Text.body).foregroundStyle(Alpine.ink).lineLimit(1)
                            }
                            .frame(minHeight: Theme.row)
                        }
                        .alpineRow()
                    }
                }
            }
        }
        .alpineGrouped()
        .navigationTitle("Save in")
        .safeAreaInset(edge: .bottom) {
            Button {
                model.folder = here
                path = []
            } label: { Text("Save here").frame(maxWidth: .infinity) }
                .buttonStyle(PrimaryCapsuleStyle())
                .padding(Alpine.Space.s6)
                .background(Alpine.ground)
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text("Save in").font(.headline).foregroundStyle(Alpine.ink)
                    Text(here.name).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
                }
            }
        }
        .task(id: here.id) {
            do { folders = .success(try await model.folders(in: here.id)) } catch { folders = .failure(error) }
        }
    }
}
