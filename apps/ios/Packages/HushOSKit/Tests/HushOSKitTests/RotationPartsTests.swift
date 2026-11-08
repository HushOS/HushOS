import Foundation
import Testing
@testable import HushOSKit

/*
 * A rotation page past the server's body cap is refused whole with 413, every time, so the rotation never finishes.
 * Parts must each fit, keep every node once and in order (parents come first in the work), and never cut a node.
 */
@Suite struct RotationPartsTests {
    let ws = "0b6d4a3e-2c1f-4d5e-8a9b-1c2d3e4f5a6b"

    func node(_ id: Int, _ size: Int) -> [String: Any] { ["id": String(id), "pad": String(repeating: "x", count: size)] }
    func body(_ nodes: [[String: Any]]) throws -> Int {
        try JSONSerialization.data(withJSONObject: ["workspaceId": ws, "nodes": nodes]).count
    }
    func ids(_ parts: [[[String: Any]]]) -> [[String]] { parts.map { $0.map { $0["id"] as! String } } }

    @Test func everyPartFitsAndThePartsAreTheBatchInOrder() throws {
        let sizes = [900, 10, 450, 3000, 1, 1999, 700, 700, 700, 2500, 5]
        let nodes = sizes.enumerated().map { node($0.offset, $0.element) }
        let parts = try rotationParts(workspaceId: ws, nodes: nodes, limit: 2048)
        #expect(ids(parts).flatMap { $0 } == sizes.indices.map(String.init))
        for part in parts {
            #expect(!part.isEmpty)
            if part.count > 1 { #expect(try body(part) <= 2048) }
        }
        // Greedy: no part could have taken the next part's first node.
        for i in parts.indices.dropLast() { #expect(try body(parts[i] + [parts[i + 1][0]]) > 2048) }
    }

    @Test func aBodyExactlyAtTheLimitIsOneRequestAndOneByteOverIsTwo() throws {
        let nodes = [node(1, 100), node(2, 100)]
        let exact = try body(nodes)
        #expect(ids(try rotationParts(workspaceId: ws, nodes: nodes, limit: exact)) == [["1", "2"]])
        #expect(ids(try rotationParts(workspaceId: ws, nodes: nodes, limit: exact - 1)) == [["1"], ["2"]])
    }

    @Test func aNodeHeavierThanTheLimitGoesAloneAndItsNeighboursStillShare() throws {
        let nodes = [node(1, 10), node(2, 10), node(3, 5000), node(4, 10), node(5, 10)]
        #expect(ids(try rotationParts(workspaceId: ws, nodes: nodes, limit: 1024)) == [["1", "2"], ["3"], ["4", "5"]])
    }

    @Test func aTypicalPageIsOneRequestAndAnEmptyOneNone() throws {
        let page = (0..<200).map { node($0, 2000) }
        #expect(try rotationParts(workspaceId: ws, nodes: page).count == 1)
        // A part must fit the server's rotation cap (ROTATION_BODY_BYTES in apps/web/src/lib/body-caps.ts).
        #expect(rotationRequestBytes <= 8 * 1024 * 1024)
        #expect(try rotationParts(workspaceId: ws, nodes: []).isEmpty)
    }
}
