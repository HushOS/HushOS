import Foundation

/*
 * The app group the app and its extensions share (the container, the shared defaults, the keychain's
 * access group, background transfers' shared container), decided the same way in every process.
 *
 * Each bundle's Info.plist names the group it was built with (HushOSAppGroup, from APP_GROUP_ID). A
 * sideloading tool (AltStore, SideStore, iloader) signs the unsigned IPA again under the person's own
 * team and gives the app a group of that team's, usually the built one with the team appended
 * (group.com.hushos.app.ABCDE12345), but leaves Info.plist alone: read from there, every process asks
 * for a group it isn't entitled to and the extensions lose the shared session. So the group comes from
 * the provisioning profile the tool embedded, when there is one: its Entitlements'
 * com.apple.security.application-groups, the entry that is the built group or extends it. App Store
 * and TestFlight builds carry no embedded profile, nor do simulator and unsigned builds; they, and a
 * profile that names no group, keep the built one.
 */
public enum AppGroup {
    /* HushOS's own group: what a bundle without HushOSAppGroup (the package's tests) was built with. */
    public static let builtIn = "group.com.hushos.app"

    public static let current: String = resolve(declared: declared(in: .main), profile: embeddedProfile(of: Bundle.main.bundleURL))

    /*
     * The group to use: the built one when the profile says nothing (no profile, no groups) or lists
     * it as it is; else the profile's entry that extends it (the built group then a dot); else the
     * profile's only group. Several groups, none of them this app's: the built one, as before.
     */
    public static func resolve(declared: String, profile: Data?) -> String {
        let groups = profile.map(applicationGroups(inProfile:)) ?? []
        if groups.isEmpty || groups.contains(declared) { return declared }
        if let extended = groups.first(where: { $0.hasPrefix(declared + ".") }) { return extended }
        if groups.count == 1 { return groups[0] }
        return declared
    }

    /*
     * The application groups a provisioning profile grants. The profile is a CMS (PKCS #7) envelope
     * with the property list inside it in the clear; iOS has no public CMS decoder, so the list is
     * taken from between its XML declaration and its closing tag. A signature is not checked: iOS
     * checked it when it installed the app, and a profile that lies only names a group the process
     * can't open.
     */
    public static func applicationGroups(inProfile data: Data) -> [String] {
        guard let start = data.range(of: Data("<?xml".utf8)),
            let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
            let plist = try? PropertyListSerialization.propertyList(from: data[start.lowerBound..<end.upperBound], format: nil) as? [String: Any],
            let entitlements = plist["Entitlements"] as? [String: Any],
            let groups = entitlements["com.apple.security.application-groups"] as? [String]
        else { return [] }
        return groups.filter { !$0.isEmpty }
    }

    /*
     * The `aps-environment` a provisioning profile grants ("development" or "production"), read the
     * same way: which APNs a development or ad hoc build's push token belongs to (PushNotifications).
     */
    public static func apsEnvironment(inProfile data: Data) -> String? {
        guard let start = data.range(of: Data("<?xml".utf8)),
            let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
            let plist = try? PropertyListSerialization.propertyList(from: data[start.lowerBound..<end.upperBound], format: nil) as? [String: Any],
            let entitlements = plist["Entitlements"] as? [String: Any]
        else { return nil }
        return entitlements["aps-environment"] as? String
    }

    /* The bundle's embedded.mobileprovision; an extension without one of its own reads its app's. */
    static func embeddedProfile(of bundle: URL) -> Data? {
        if let own = try? Data(contentsOf: bundle.appendingPathComponent("embedded.mobileprovision")) { return own }
        // Extensions live in <App>.app/PlugIns or <App>.app/Extensions.
        let parent = bundle.deletingLastPathComponent()
        guard bundle.pathExtension == "appex", ["PlugIns", "Extensions"].contains(parent.lastPathComponent) else { return nil }
        return try? Data(contentsOf: parent.deletingLastPathComponent().appendingPathComponent("embedded.mobileprovision"))
    }

    private static func declared(in bundle: Bundle) -> String {
        (bundle.object(forInfoDictionaryKey: "HushOSAppGroup") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? builtIn
    }
}
