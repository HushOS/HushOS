import Foundation
import Testing
@testable import HushOSKit

/*
 * A new device record is named after the model, so two iPhones on one account can be told apart,
 * and the name must pass the server's rule or the sign-in's registration is refused.
 */
@Suite struct DeviceModelTests {
    /* The server's rule, copied from `normalizeDeviceName` in packages/auth/src/server.ts. */
    static let serverRule = try! NSRegularExpression(pattern: "^[\\p{L}\\p{M}\\p{N} '’()._·-]+$")

    static func accepted(_ name: String) -> Bool {
        let range = NSRange(name.startIndex..., in: name)
        return (1...40).contains(name.unicodeScalars.count) && serverRule.firstMatch(in: name, range: range) != nil
    }

    @Test func aKnownIdentifierIsNamedAfterItsModel() {
        #expect(DeviceModel.name(identifier: "iPhone17,1", pad: false) == "iPhone 16 Pro")
        #expect(DeviceModel.name(identifier: "iPhone18,4", pad: false) == "iPhone Air")
        #expect(DeviceModel.name(identifier: "iPhone19,2", pad: false) == "iPhone 18 Pro")
        #expect(DeviceModel.name(identifier: "iPhone12,8", pad: false) == "iPhone SE (2nd generation)")
    }

    @Test func wiFiAndCellularIPadsShareTheirModelsName() {
        // Xcode's simulator knows only iPad16,4; the Wi-Fi model is iPad16,3.
        #expect(DeviceModel.name(identifier: "iPad16,3", pad: true) == "iPad Pro 11-inch (M4)")
        #expect(DeviceModel.name(identifier: "iPad16,4", pad: true) == "iPad Pro 11-inch (M4)")
        #expect(DeviceModel.name(identifier: "iPad13,4", pad: true) == "iPad Pro (11-inch) (3rd generation)")
        #expect(DeviceModel.name(identifier: "iPad13,11", pad: true) == "iPad Pro (12.9-inch) (5th generation)")
    }

    @Test func anUnknownIdentifierIsNamedByTheFamilyItNames() {
        // A model newer than this build: its family, whatever the screen's idiom says.
        #expect(DeviceModel.name(identifier: "iPhone99,1", pad: true) == "iPhone")
        #expect(DeviceModel.name(identifier: "iPad99,1", pad: false) == "iPad")
    }

    @Test func noIdentifierIsNamedByTheScreen() {
        // A simulator without SIMULATOR_MODEL_IDENTIFIER reports the host's "arm64".
        #expect(DeviceModel.name(identifier: nil, pad: false) == "iPhone")
        #expect(DeviceModel.name(identifier: nil, pad: true) == "iPad")
        #expect(DeviceModel.name(identifier: "arm64", pad: true) == "iPad")
        #expect(DeviceModel.name(identifier: "", pad: false) == "iPhone")
    }

    @Test func everyNameInTheTablePassesTheServersRule() {
        for (_, name) in DeviceModel.models {
            #expect(Self.accepted(name), "\(name) is refused by the server")
        }
    }

    @Test func noIdentifierIsListedTwice() {
        // A repeated identifier would silently take whichever model came last.
        let listed = DeviceModel.models.flatMap(\.0)
        #expect(Set(listed).count == listed.count)
        #expect(DeviceModel.names.count == listed.count)
    }

    @Test func theDeviceThisRunsOnIsNamed() {
        // The tests run on a simulator, which names its model in SIMULATOR_MODEL_IDENTIFIER.
        let identifier = DeviceModel.identifier()
        #expect(identifier?.hasPrefix("iPhone") == true || identifier?.hasPrefix("iPad") == true)
    }
}
