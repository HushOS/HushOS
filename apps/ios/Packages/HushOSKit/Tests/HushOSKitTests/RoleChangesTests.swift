import Testing
@testable import HushOSKit

/*
 * Whose role change runs on the family page (RoleChanges), across a session reset. Codex #285, 2:
 * the same account's session adopted in place resets the families; a change begun before it must
 * not keep the menus disabled, and its late end must not clear the next session's change.
 */
@Suite struct RoleChangesTests {
    /* Fails if a reset leaves the last session's change running: the menus stay disabled for good. */
    @Test func aResetLetsTheNextSessionChangeRoles() {
        var changes = RoleChanges()
        let before = changes.begin("A")
        #expect(before != nil)
        #expect(changes.begin("B") == nil, "two changes at once")
        changes.reset()
        #expect(changes.busy == nil)
        #expect(changes.begin("B") != nil, "the next session's change couldn't begin")
    }

    /* Fails if the ended session's late answer clears the change the next session began. */
    @Test func aLateEndOfTheLastSessionLeavesTheNextOnesChangeRunning() throws {
        var changes = RoleChanges()
        let began = changes.begin("A")
        let old = try #require(began)
        changes.reset()
        let again = changes.begin("A")
        let next = try #require(again)
        changes.end(old)
        #expect(changes.busy == "a", "an ended session's answer cleared the next session's change")
        changes.end(next)
        #expect(changes.busy == nil)
    }
}
