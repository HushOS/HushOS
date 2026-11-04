import Foundation
import Testing
@testable import HushOSKit

/*
 * The app group a sideloaded build runs under. AltStore, SideStore and iloader sign the unsigned IPA
 * again under the person's team with that team's group (group.com.hushos.app.<TEAMID>) and leave
 * Info.plist naming the built one; a process that asks for the built group opens nothing, and the
 * Files extension and the share sheet lose the session the app signed in with. The fixtures are CMS
 * envelopes shaped as a free account's team profile (`security cms -D` reads them), signed with a
 * throwaway key: one granting another app's group and the team's HushOS group, one granting none.
 */
@Suite struct AppGroupTests {
    private static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../Fixtures").standardized
    private func profile(_ name: String) throws -> Data { try Data(contentsOf: Self.fixtures.appendingPathComponent("\(name).mobileprovision")) }

    @Test func aSideloadedProfileGivesTheTeamsGroupNotTheBuiltOne() throws {
        let sideloaded = try profile("sideloaded")
        #expect(AppGroup.applicationGroups(inProfile: sideloaded) == ["group.com.example.other", "group.com.hushos.app.ABCDE12345"])
        #expect(AppGroup.resolve(declared: AppGroup.builtIn, profile: sideloaded) == "group.com.hushos.app.ABCDE12345")
    }

    @Test func noProfileOrNoGroupsKeepsTheBuiltGroup() throws {
        // App Store and TestFlight builds, the simulator and an unsigned build have no embedded profile.
        #expect(AppGroup.resolve(declared: AppGroup.builtIn, profile: nil) == AppGroup.builtIn)
        let none = try profile("no-groups")
        #expect(AppGroup.applicationGroups(inProfile: none).isEmpty)
        #expect(AppGroup.resolve(declared: AppGroup.builtIn, profile: none) == AppGroup.builtIn)
        // Not a profile at all.
        #expect(AppGroup.resolve(declared: AppGroup.builtIn, profile: Data("not a profile".utf8)) == AppGroup.builtIn)
    }

    @Test func aForkIsNeverGivenHushOSsGroup() throws {
        // A fork built with its own APP_GROUP_ID matches by that, never by HushOS's name.
        #expect(AppGroup.resolve(declared: "group.org.example.drive", profile: try profile("sideloaded")) == "group.org.example.drive")
    }

    /*
     * Every process opens the same profile: the app its own, an extension its own if the tool gave it
     * one, else the app's two folders up (PlugIns or Extensions), so the extensions agree with the app.
     */
    @Test func anExtensionWithoutAProfileReadsItsAppsOne() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("AppGroupTests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appendingPathComponent("HushOS.app")
        let files = app.appendingPathComponent("PlugIns/HushOSFiles.appex")
        let share = app.appendingPathComponent("PlugIns/HushOSShare.appex")
        let stray = root.appendingPathComponent("Loose.appex")
        for folder in [files, share, stray] { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
        let sideloaded = try profile("sideloaded")
        try sideloaded.write(to: app.appendingPathComponent("embedded.mobileprovision"))
        try profile("no-groups").write(to: share.appendingPathComponent("embedded.mobileprovision"))

        #expect(AppGroup.embeddedProfile(of: app) == sideloaded)
        #expect(AppGroup.resolve(declared: AppGroup.builtIn, profile: AppGroup.embeddedProfile(of: files)) == "group.com.hushos.app.ABCDE12345")
        // An extension's own profile wins over the app's.
        #expect(AppGroup.embeddedProfile(of: share) == (try profile("no-groups")))
        // An extension outside an app's PlugIns has no app to fall back on.
        #expect(AppGroup.embeddedProfile(of: stray) == nil)
    }
}
