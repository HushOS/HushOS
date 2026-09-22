import Foundation
import HushOSCore

/* An operator as `GET /api/drive/reports/operators` lists them. */
public struct ReportOperator: Codable, Sendable {
    public struct Kem: Codable, Sendable {
        public let publicKey: String
        public let signature: String
    }
    public let userId: String
    public let encryptionPublicKey: String
    public let signingPublicKey: String
    public let kem: Kem?
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
     * The report body: the node key sealed to every operator with the
     * report's context bound in, so the server, holding public keys only,
     * cannot open it, and an operator can open only this report.
     */
    static func body(api: PublicAPI, item: Opened, nodeKey: Data, category: String, reason: String, email: String?, via: [String: Any]) async throws -> [String: Any] {
        struct Operators: Decodable { let operators: [ReportOperator] }
        let operators = try await api.openOperators()
        guard !operators.isEmpty else { throw DriveAPIError.server(503, "This HushOS has no operators to report to.") }
        let reportId = UUID().uuidString.lowercased()
        let keys: [[String: Any]] = try operators.map { operator_ in
            let ctx = ReportContext(
                workspaceId: item.node.workspaceId, nodeId: item.id, keyEpoch: item.node.keyEpoch,
                reportId: reportId, operatorUserId: operator_.userId
            )
            let keys = OperatorKeys(
                userId: operator_.userId, encryptionPublicKey: operator_.encryptionPublicKey, signingPublicKey: operator_.signingPublicKey,
                kem: operator_.kem.map { OperatorKem(publicKey: $0.publicKey, signature: $0.signature) }
            )
            return ["operatorUserId": operator_.userId, "keyEnvelope": base64urlEncode(bytes: try reportSealKey(ctx: ctx, nodeKey: nodeKey, operator: keys))]
        }
        let trimmedEmail = email?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return [
            "id": reportId, "workspaceId": item.node.workspaceId, "nodeId": item.id, "keyEpoch": item.node.keyEpoch,
            "category": category, "reason": reason, "via": via,
            "reporterEmail": trimmedEmail.isEmpty ? NSNull() : trimmedEmail, "contentHash": NSNull(), "keys": keys,
        ]
    }
}

extension PublicAPI {
    func openOperators() async throws -> [ReportOperator] {
        var request = URLRequest(url: URL(string: origin + "/api/drive/reports/operators")!)
        request.setValue("ios/2", forHTTPHeaderField: "HushOS-Client")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw DriveAPIError.server(0, "Could not load the operators.") }
        return try JSONDecoder().decode(OperatorsResponse.self, from: data).operators
    }
}

extension Vault {
    /* Files a report on an item shared with this account; the session names the reporter. */
    public func report(_ item: Opened, category: String, reason: String, email: String?) async throws -> Bool {
        guard let nodeKey = nodeKeys[item.id] else { throw DriveAPIError.server(500, "Node not opened") }
        let body = try await Reports.body(api: PublicAPI(origin: session.origin), item: item, nodeKey: nodeKey, category: category, reason: reason, email: email, via: ["share": true])
        return try await api.performPublic(try api.mutationPublic("/reports", body: body), as: ReportFiled.self).duplicate
    }
}
