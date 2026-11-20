import Foundation
import HushOSCore

/*
 * An operator as `GET /api/drive/reports/operators` lists them: the server's word, not a key
 * anyone checked. The core seals to a version 2 operator's ML-KEM key only once their keys
 * statement holds, to a version 1 operator's as served, and refuses one with none.
 */
public struct ReportOperator: Codable, Sendable {
    public let userId: String
    public let keyVersion: UInt64
    public var identityVersion: Int? = nil
    public let encryptionPublicKey: String
    public let signingPublicKey: String
    public var mlDsaPublicKey: String? = nil
    public var kemPublicKey: String? = nil
    public var keysSignature: String? = nil

    /* What the core seals to: every key and the statement as served, for it to check. */
    var keys: OperatorKeys {
        OperatorKeys(userId: userId, keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey,
                     mlDsaPublicKey: mlDsaPublicKey, kemPublicKey: kemPublicKey, keysSignature: keysSignature)
    }
}

struct OperatorsResponse: Codable, Sendable { let operators: [ReportOperator] }
struct ReportFiled: Codable, Sendable {
    struct Report: Codable, Sendable { let id: String }
    let report: Report
    let duplicate: Bool
}

/* What can be reported, in the words the web uses. */
public enum Reports {
    public static let categories: [(id: String, label: String)] = [
        ("csam", "Child sexual abuse material"),
        ("terrorism", "Terrorist content"),
        ("ncii", "Intimate images shared without consent"),
        ("malware", "Malware"),
        ("copyright", "Copyright infringement"),
        ("harassment", "Harassment"),
        ("other", "Something else"),
    ]

    /*
     * The report body: the node key sealed to every operator with the report's
     * context bound in, so an operator can open only this report. The operator
     * keys come from the server and nothing here checks them against anyone
     * this person verified: whoever runs the server can list keys of their own
     * and open what is reported. That is what reporting means, and the report
     * sheet says so.
     */
    static func body(api: PublicAPI, item: Opened, nodeKey: Data, category: String, reason: String, email: String?, via: [String: Any]) async throws -> [String: Any] {
        struct Operators: Decodable { let operators: [ReportOperator] }
        let operators = try await api.openOperators()
        guard !operators.isEmpty else { throw DriveAPIError.server(503, "This HushOS has no operators to report to.") }
        // Scoped to the reported item's workspace, as the server derives it.
        let made = try newId(kind: .report, scopeId: item.node.workspaceId)
        let reportId = made.id
        let keys: [[String: Any]] = try operators.map { operator_ in
            let ctx = ReportContext(
                workspaceId: item.node.workspaceId, nodeId: item.id, keyEpoch: item.node.keyEpoch,
                reportId: reportId, operatorUserId: operator_.userId
            )
            return ["operatorUserId": operator_.userId, "keyEnvelope": base64urlEncode(bytes: try reportSealKey(ctx: ctx, nodeKey: nodeKey, operator: operator_.keys))]
        }
        let trimmedEmail = email?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return [
            "id": reportId, "reportIdSeed": made.seed, "workspaceId": item.node.workspaceId, "nodeId": item.id, "keyEpoch": item.node.keyEpoch,
            "category": category, "reason": reason, "via": via,
            "reporterEmail": trimmedEmail.isEmpty ? NSNull() : trimmedEmail, "keys": keys,
        ]
    }
}

extension PublicAPI {
    func openOperators() async throws -> [ReportOperator] {
        var request = URLRequest(url: URL(string: origin + "/api/drive/reports/operators")!)
        // No session rides along: a report about a link is anonymous.
        request.httpShouldHandleCookies = false
        request.setValue(DriveAPI.clientHeader, forHTTPHeaderField: "HushOS-Client")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw DriveAPIError.server(0, "Could not load the operators.") }
        return try JSONDecoder().decode(OperatorsResponse.self, from: data).operators
    }
}

extension Vault {
    /* Files a report on an item shared with this account; the session names the reporter. */
    public func report(_ item: Opened, category: String, reason: String, email: String?) async throws -> Bool {
        // Never for a family folder's items: there is nobody's share to report through, and the item is the family's.
        try refuseFamilyWrite(item.node.workspaceId)
        guard let nodeKey = nodeKey(of: item) else { throw DriveAPIError.server(500, "Node not opened") }
        let body = try await Reports.body(api: PublicAPI(origin: session.origin), item: item, nodeKey: nodeKey, category: category, reason: reason, email: email, via: ["share": true])
        return try await api.performPublic(try api.mutationPublic("/reports", body: body), as: ReportFiled.self).duplicate
    }
}
