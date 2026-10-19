import Foundation

/*
 * What this iPhone or iPad calls itself in the device list: its model's marketing name ("iPhone 16
 * Pro"), read from the hardware identifier ("iPhone17,1"), never the name its owner gave it
 * (`UIDevice.current.name` is "iPhone" anyway since iOS 16). An identifier the table doesn't know
 * (a model newer than this build) is named by its family, "iPhone" or "iPad". The person can rename it.
 *
 * The table covers the models that run iOS and iPadOS 26, the app's minimum. Sources, checked
 * 2026-10-20: Xcode 27.1's simulator device types (`xcrun simctl list devicetypes -j`, `modelIdentifier`
 * and `name`), which give one identifier per model; the other identifiers of a model (Wi-Fi and
 * cellular iPads, 1 TB iPad Pros) from https://gist.github.com/adamawolf/3048717 and, for iPad17,1 and
 * iPad17,3, https://appledb.dev/device-selection/iPad-Pro.html. Names are Xcode's, and every one passes the server's
 * rule (`normalizeDeviceName`: up to 40 letters, numbers, spaces and `'’()._·-`), which a test holds.
 */
public enum DeviceModel {
    static let names: [String: String] = {
        var names: [String: String] = [:]
        for (identifiers, name) in models {
            for identifier in identifiers { names[identifier] = name }
        }
        return names
    }()

    static let models: [([String], String)] = [
        (["iPhone12,1"], "iPhone 11"),
        (["iPhone12,3"], "iPhone 11 Pro"),
        (["iPhone12,5"], "iPhone 11 Pro Max"),
        (["iPhone12,8"], "iPhone SE (2nd generation)"),
        (["iPhone13,1"], "iPhone 12 mini"),
        (["iPhone13,2"], "iPhone 12"),
        (["iPhone13,3"], "iPhone 12 Pro"),
        (["iPhone13,4"], "iPhone 12 Pro Max"),
        (["iPhone14,2"], "iPhone 13 Pro"),
        (["iPhone14,3"], "iPhone 13 Pro Max"),
        (["iPhone14,4"], "iPhone 13 mini"),
        (["iPhone14,5"], "iPhone 13"),
        (["iPhone14,6"], "iPhone SE (3rd generation)"),
        (["iPhone14,7"], "iPhone 14"),
        (["iPhone14,8"], "iPhone 14 Plus"),
        (["iPhone15,2"], "iPhone 14 Pro"),
        (["iPhone15,3"], "iPhone 14 Pro Max"),
        (["iPhone15,4"], "iPhone 15"),
        (["iPhone15,5"], "iPhone 15 Plus"),
        (["iPhone16,1"], "iPhone 15 Pro"),
        (["iPhone16,2"], "iPhone 15 Pro Max"),
        (["iPhone17,1"], "iPhone 16 Pro"),
        (["iPhone17,2"], "iPhone 16 Pro Max"),
        (["iPhone17,3"], "iPhone 16"),
        (["iPhone17,4"], "iPhone 16 Plus"),
        (["iPhone17,5"], "iPhone 16e"),
        (["iPhone18,1"], "iPhone 17 Pro"),
        (["iPhone18,2"], "iPhone 17 Pro Max"),
        (["iPhone18,3"], "iPhone 17"),
        (["iPhone18,4"], "iPhone Air"),
        (["iPhone18,5"], "iPhone 17e"),
        (["iPhone19,2"], "iPhone 18 Pro"),
        (["iPhone19,3"], "iPhone 18 Pro Max"),
        (["iPhone19,4"], "iPhone Duo"),

        (["iPad8,1", "iPad8,2", "iPad8,3", "iPad8,4"], "iPad Pro (11-inch) (1st generation)"),
        (["iPad8,5", "iPad8,6", "iPad8,7", "iPad8,8"], "iPad Pro (12.9-inch) (3rd generation)"),
        (["iPad8,9", "iPad8,10"], "iPad Pro (11-inch) (2nd generation)"),
        (["iPad8,11", "iPad8,12"], "iPad Pro (12.9-inch) (4th generation)"),
        (["iPad11,1", "iPad11,2"], "iPad mini (5th generation)"),
        (["iPad11,3", "iPad11,4"], "iPad Air (3rd generation)"),
        (["iPad11,6", "iPad11,7"], "iPad (8th generation)"),
        (["iPad12,1", "iPad12,2"], "iPad (9th generation)"),
        (["iPad13,1", "iPad13,2"], "iPad Air (4th generation)"),
        (["iPad13,4", "iPad13,5", "iPad13,6", "iPad13,7"], "iPad Pro (11-inch) (3rd generation)"),
        (["iPad13,8", "iPad13,9", "iPad13,10", "iPad13,11"], "iPad Pro (12.9-inch) (5th generation)"),
        (["iPad13,16", "iPad13,17"], "iPad Air (5th generation)"),
        (["iPad13,18", "iPad13,19"], "iPad (10th generation)"),
        (["iPad14,1", "iPad14,2"], "iPad mini (6th generation)"),
        (["iPad14,3", "iPad14,4"], "iPad Pro (11-inch) (4th generation)"),
        (["iPad14,5", "iPad14,6"], "iPad Pro (12.9-inch) (6th generation)"),
        (["iPad14,8", "iPad14,9"], "iPad Air 11-inch (M2)"),
        (["iPad14,10", "iPad14,11"], "iPad Air 13-inch (M2)"),
        (["iPad15,3", "iPad15,4"], "iPad Air 11-inch (M3)"),
        (["iPad15,5", "iPad15,6"], "iPad Air 13-inch (M3)"),
        (["iPad15,7", "iPad15,8"], "iPad (A16)"),
        (["iPad16,1", "iPad16,2"], "iPad mini (A17 Pro)"),
        (["iPad16,3", "iPad16,4"], "iPad Pro 11-inch (M4)"),
        (["iPad16,5", "iPad16,6"], "iPad Pro 13-inch (M4)"),
        (["iPad16,8", "iPad16,9"], "iPad Air 11-inch (M4)"),
        (["iPad16,10", "iPad16,11"], "iPad Air 13-inch (M4)"),
        (["iPad17,1", "iPad17,2"], "iPad Pro 11-inch (M5)"),
        (["iPad17,3", "iPad17,4"], "iPad Pro 13-inch (M5)"),
    ]

    /*
     * The name for a hardware identifier: the model's name when the table has it, else the family the
     * identifier names, else the family the screen says (`pad` from the interface idiom), for an
     * identifier that is missing or names no family ("arm64" on a simulator without its variable).
     */
    public static func name(identifier: String?, pad: Bool) -> String {
        if let identifier, let name = names[identifier] { return name }
        if identifier?.hasPrefix("iPad") == true { return "iPad" }
        if identifier?.hasPrefix("iPhone") == true { return "iPhone" }
        return pad ? "iPad" : "iPhone"
    }

    /* The hardware identifier: the simulated model's on a simulator, the machine's on a device. */
    public static func identifier() -> String? {
        #if targetEnvironment(simulator)
        return ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"]
        #else
        var system = utsname()
        guard uname(&system) == 0 else { return nil }
        let machine = withUnsafeBytes(of: &system.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        return machine.isEmpty ? nil : machine
        #endif
    }
}
