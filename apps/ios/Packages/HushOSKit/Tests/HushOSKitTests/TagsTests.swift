import Foundation
import Testing
@testable import HushOSKit

/*
 * The tags registry is one document every client of the workspace writes. A save that rebuilt it from
 * the fields this version knows would erase whatever a newer client keeps there (on the registry, on a
 * tag, beside the memberships) the moment someone tagged a file on this phone.
 */
struct TagRegistryTests {
    let work = "11111111-1111-4111-8111-111111111111"
    let home = "22222222-2222-4222-8222-222222222222"
    let fileA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    let fileB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    var document: String {
        """
        {"version":2,"order":"manual",
         "tags":[{"id":"\(work)","name":"Work","colour":"blue","pinned":true},
                 {"id":"\(home)","name":"Home","colour":"teal","icon":"house"}],
         "items":{"\(work)":["\(fileA)"],"\(home)":["\(fileA)","\(fileB)"],"smart:recent":["\(fileB)"]}}
        """
    }

    /* What a save writes, as the next device reads it. */
    func saved(_ registry: TagRegistry) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: Data(try registry.json().utf8)) as? [String: Any])
    }

    func tag(_ document: [String: Any], _ id: String) throws -> [String: Any] {
        try #require((document["tags"] as? [[String: Any]])?.first { $0["id"] as? String == id })
    }

    func members(_ document: [String: Any], _ id: String) -> [String]? {
        (document["items"] as? [String: Any])?[id] as? [String]
    }

    @Test func unknownFieldsSurviveAddRenameRemoveAndAssign() throws {
        var registry = try TagRegistry(json: Data(document.utf8))
        let added = try registry.add(name: "Taxes")
        try registry.rename(work, to: "Office")
        try registry.assign(fileB, tagIds: [work, added.id])
        registry.remove(home)
        let json = try saved(try TagRegistry(json: Data(try registry.json().utf8)))

        #expect(json["order"] as? String == "manual")
        #expect(try tag(json, work)["pinned"] as? Bool == true)
        #expect(members(json, "smart:recent") == [fileB])
        // The edits themselves.
        #expect(try tag(json, work)["name"] as? String == "Office")
        #expect(members(json, work) == [fileA, fileB])
        #expect(members(json, added.id) == [fileB])
        #expect((json["tags"] as? [[String: Any]])?.compactMap { $0["id"] as? String } == [work, added.id])
        #expect(members(json, home) == nil)
        #expect(json["version"] as? Int == 2)
    }

    @Test func aTagKeepsItsOwnUnknownFieldsUntilItIsRemoved() throws {
        var registry = try TagRegistry(json: Data(document.utf8))
        registry.recolour(home, to: "#00aa88")
        #expect(try tag(try saved(registry), home)["icon"] as? String == "house")
        #expect(try tag(try saved(registry), home)["colour"] as? String == "#00aa88")
        registry.remove(home)
        #expect((try saved(registry)["tags"] as? [Any])?.count == 1)
    }

    @Test func unassigningEmptiesOnlyThatTagAndKeepsTheOthersInOrder() throws {
        var registry = try TagRegistry(json: Data(document.utf8))
        // fileA stays in Home: it keeps its place ahead of fileB rather than moving to the end.
        try registry.assign(fileA, tagIds: [home])
        let json = try saved(registry)
        #expect(members(json, work) == nil)
        #expect(members(json, home) == [fileA, fileB])
        #expect(members(json, "smart:recent") == [fileB])
    }

    @Test func aRegistryFromANewerFormatIsRefusedRatherThanRewritten() {
        #expect(throws: AuthError.self) {
            try TagRegistry(json: Data(document.replacingOccurrences(of: #""version":2"#, with: #""version":3"#).utf8))
        }
    }

    @Test func anEmptyRegistrySavesTheWebsShape() throws {
        var registry = TagRegistry.empty
        let tag = try registry.add(name: "Work")
        try registry.assign(fileA, tagIds: [tag.id])
        let json = try saved(registry)
        #expect(Set(json.keys) == ["version", "tags", "items"])
        #expect(members(json, tag.id) == [fileA])
    }
}
