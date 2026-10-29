import Foundation
import Testing
@testable import HushOSKit

/*
 * Info beside the list must never show a name or a place the item no longer has, or offer
 * Share, Tags or Move on an item that went to the Trash; nor may it close on an item the store
 * simply never listed (a share's top folder), which would make Info impossible to open there.
 */
@Suite struct InfoFollowTests {
    func opened(_ id: String, name: String, parent: String = "p", trashed: String? = nil) -> Opened {
        let node = NodeView(id: id, workspaceId: "own", parentId: parent, kind: "file", keyEpoch: 1, parentKeyEpoch: 1,
                            keyEnvelope: "", metadataVersion: 1, metadataEnvelope: "", currentVersion: nil, trashedAt: trashed,
                            changeSeq: 1, createdAt: nil, updatedAt: nil)
        return Opened(node: node, metadata: NodeMetadata(name: name, mime: nil, size: 3, modified: nil, attributes: [:]), nodeKey: nil)
    }

    @Test func aRenameShowsTheNewName() throws {
        let shown = opened("n1", name: "Trip plan.md")
        let follow = try #require(InfoFollow(shown, current: shown))
        let renamed = try #require(follow.following(opened("n1", name: "Lisbon plan.md")))
        #expect(renamed.item.name == "Lisbon plan.md")
    }

    @Test func aMoveShowsTheNewFolder() throws {
        let shown = opened("n1", name: "Trip plan.md", parent: "home")
        let follow = try #require(InfoFollow(shown, current: shown))
        let moved = try #require(follow.following(opened("n1", name: "Trip plan.md", parent: "lisbon")))
        #expect(moved.item.node.parentId == "lisbon")
    }

    @Test func trashingTheItemClosesInfo() throws {
        let shown = opened("n1", name: "Trip plan.md")
        let follow = try #require(InfoFollow(shown, current: shown))
        #expect(follow.following(opened("n1", name: "Trip plan.md", trashed: "2026-10-29T18:00:00Z")) == nil)
    }

    /* Trashed or deleted elsewhere, or dropped by a sync: the store stops listing it. */
    @Test func anItemTheStoreStopsListingClosesInfo() throws {
        let shown = opened("n1", name: "Trip plan.md")
        let follow = try #require(InfoFollow(shown, current: shown))
        #expect(follow.following(nil) == nil)
    }

    /* A share's top folder lives only in the Shared tab's list: Info opens and stays open. */
    @Test func anItemTheStoreNeverListedStaysOpen() throws {
        let shown = opened("root", name: "Shared to me")
        let follow = try #require(InfoFollow(shown, current: nil))
        let still = try #require(follow.following(nil))
        #expect(still.item.name == "Shared to me")
    }

    /* Once it shows up in a list, it is followed like any other item, gone included. */
    @Test func anItemListedLaterIsFollowedFromThen() throws {
        let shown = opened("n1", name: "Old")
        let follow = try #require(InfoFollow(shown, current: nil))
        let listed = try #require(follow.following(opened("n1", name: "New")))
        #expect(listed.item.name == "New")
        #expect(listed.following(nil) == nil)
    }

    @Test func infoOnAnItemAlreadyTrashedDoesNotOpen() {
        let shown = opened("n1", name: "Trip plan.md")
        #expect(InfoFollow(shown, current: opened("n1", name: "Trip plan.md", trashed: "2026-10-29T18:00:00Z")) == nil)
    }
}
