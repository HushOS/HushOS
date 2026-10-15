import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * A report's node key is sealed to each operator as the server lists them, every key and the
 * statement passed through for the core to check. A version 2 operator's ML-KEM key counts only
 * under their keys statement, so a KEM key swapped beside a valid statement is refused; an
 * operator with no KEM key is refused rather than sealed to classically. (Served without the
 * statement, an operator reads as version 1 and is sealed to as served: nobody pins operator
 * keys, so the server could list keys of its own anyway.)
 */
struct ReportOperatorTests {
    let operatorId = UUID().uuidString.lowercased()

    /* An operator row as `GET /api/drive/reports/operators` serves it. */
    func row(_ envelope: IdentityEnvelope, kem: String?? = nil) throws -> ReportOperator {
        var json: [String: Any] = [
            "userId": operatorId, "keyVersion": envelope.keyVersion, "identityVersion": envelope.version,
            "encryptionPublicKey": envelope.encryptionPublicKey, "signingPublicKey": envelope.signingPublicKey,
            "mlDsaPublicKey": envelope.mlDsa?.publicKey ?? NSNull(),
        ]
        json["kemPublicKey"] = (kem ?? envelope.kem?.publicKey) ?? NSNull()
        json["keysSignature"] = envelope.keysSignature ?? NSNull()
        return try JSONDecoder().decode(ReportOperator.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func seal(_ operator_: ReportOperator) throws -> Data {
        let ctx = ReportContext(workspaceId: UUID().uuidString.lowercased(), nodeId: UUID().uuidString.lowercased(), keyEpoch: 2,
                                reportId: UUID().uuidString.lowercased(), operatorUserId: operator_.userId)
        return try reportSealKey(ctx: ctx, nodeKey: try randomBytes(length: 32), operator: operator_.keys)
    }

    @Test func anUpgradedOperatorIsSealedToOnlyUnderTheirKeysStatement() throws {
        let identity = try makeIdentity(operatorId)
        let other = try makeIdentity(operatorId)
        #expect(try seal(try row(identity.envelope)).count == 1224)
        // Another ML-KEM key beside their statement: not theirs, not sealed to.
        #expect(throws: (any Error).self) { try seal(try row(identity.envelope, kem: other.envelope.kem?.publicKey)) }
    }

    @Test func anOperatorWithoutAPostQuantumKeyIsRefused() throws {
        let identity = try makeIdentity(operatorId)
        // Not upgraded yet: sealed to the served ML-KEM key, which nobody pins for operators.
        #expect(try seal(try row(versionOne(identity.envelope))).count == 1224)
        #expect(throws: (any Error).self) { try seal(try row(versionOne(identity.envelope), kem: .some(nil))) }
    }
}
